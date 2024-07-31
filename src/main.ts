import { XMLParser } from 'fast-xml-parser';
import arg from 'arg';
import fs from 'node:fs/promises';
import winston from 'winston';

const logger = winston.createLogger({
    transports: [new winston.transports.Console()]
})

const args = arg({
    '-o': '--output',
    '-v': '--version',
    '-l': '--links',
    '--links': [String],
    '--verbose': Boolean,
})

/**
 * Returns the last url which ends with manifest.mpd mentioned in the fetched url document
 * @param url 
 * @returns 
 */
async function getManifestUrl(url: string): Promise<string | undefined> {
    const resp = await fetch(url);
    const manifestUrls = (await resp.text()).matchAll(/https?:\/\/[^"\s]+?manifest.mpd/g);
    let lastManiUrl = undefined;
    for(const [manifestUrl, _] of manifestUrls) {
        lastManiUrl = manifestUrl
    }
    return lastManiUrl;
}

async function fetchAndParseManifestFile(manifestUrl: string): Promise<{baseUrl: string, videoAdaptionSet: AdaptionSet, audioAdaptionSet: AdaptionSet}> {
    logger.info(`manifestUrl as found in .html file: ${manifestUrl}`);
    const resp = await fetch(manifestUrl);
    logger.info(`found manifest file on: ${resp.url}`);
    const baseUrl = resp.url.substring(0, resp.url.lastIndexOf("/") + 1)
    logger.info(`baseUrl: ${baseUrl}`);
    const asText = await resp.text();
    const parser = new XMLParser({
        parseAttributeValue: true,
        ignoreAttributes: false,
    });
    const document = parser.parse(asText);
    const adaptionSets = document.MPD.Period.AdaptationSet as Array<any>;
    const videoAdaptionSet = mapRawAdaptionSetToDs(adaptionSets.find(z => z["@_mimeType"] === "video/mp4"));
    const audioAdaptionSet = mapRawAdaptionSetToDs(adaptionSets.find(z => z["@_mimeType"] === "audio/mp4"))
    return {
        baseUrl,
        videoAdaptionSet,
        audioAdaptionSet,
    };
}

/**
 * some pretty good garbage code
 * @param adaptionSetRaw 
 * @returns 
 */
function mapRawAdaptionSetToDs(adaptionSetRaw: any): AdaptionSet {
    const segmentTemplate: SegmentTemplate = {
        media: adaptionSetRaw["SegmentTemplate"]["@_media"],
        initialization: adaptionSetRaw["SegmentTemplate"]["@_initialization"],
        segmentTimeline: {
            segments: (adaptionSetRaw["SegmentTemplate"]["SegmentTimeline"]["S"] as Array<any>).map((t) => {
                return {
                    d: t["@_d"],
                    t: t["@_t"],
                    r: t["@_r"],
                }
            })
        }
    }
    let representations: Representation[] = [];
    if(adaptionSetRaw["Representation"]?.length) {
        representations = (adaptionSetRaw["Representation"] as Array<any>).map((t) => {
            return {
                id: t["@_id"] as string,
                codecs: t["@_codecs"] as string,
                ...(t["@_audioSamplingRate"] ? {audioSamplingRate: t["@_audioSamplingRate"] as string} : {}),
                ...(t["@_width"] ? {width: t["@_width"] as string} : {}),
                ...(t["@_height"] ? {height: t["@_height"] as string} : {}),
            } as Representation;
        })
    } else {
        representations = [{
            id: adaptionSetRaw["Representation"]["@_id"],
            codecs: adaptionSetRaw["Representation"]["@_codecs"] as string,
            ...(adaptionSetRaw["Representation"]["@_audioSamplingRate"] ? {audioSamplingRate: adaptionSetRaw["Representation"]["@_audioSamplingRate"] as string} : {}),
            ...(adaptionSetRaw["Representation"]["@_width"] ? {width: adaptionSetRaw["Representation"]["@_width"] as string} : {}),
            ...(adaptionSetRaw["Representation"]["@_height"] ? {height: adaptionSetRaw["Representation"]["@_height"] as string} : {}),
        } as Representation]
    }
    const adaptionSet: AdaptionSet = {
        id: adaptionSetRaw["@_id"],
        group: adaptionSetRaw["@_group"],
        mimeType: adaptionSetRaw["@_mimeType"],
        segmentTemplate,
        representations,
    }
    return adaptionSet;
}

// TODO refactor
function partitionArray<T>(arr: Array<T>, chunksize: number): Array<Array<T>> {
    const res = [];
    for (let i = 0; i < arr.length; i += chunksize) {
        const chunk = arr.slice(i, i + chunksize);
        res.push(chunk);
    }
    return res;
}

async function downloadSegmentsAndSaveToFile(adaptionSet: AdaptionSet, representationId: string, baseUrl: string, filename: string) {
    let time = 0;
    const lastPaths = adaptionSet.segmentTemplate.segmentTimeline.segments.flatMap((s) => {
        let reps = 1;
        if(s.r) reps += s.r;
        const agg = [];
        for(let i = 0; i < reps; i++) {
            const lastPath = (adaptionSet.segmentTemplate.media.replace("$RepresentationID$", representationId).replace("$Time$", `${time}`));
            agg.push(lastPath);
            time += s.d;
        }
        return agg;
    });
    // also insert the init thingy
    lastPaths.unshift(adaptionSet.segmentTemplate.initialization.replace("$RepresentationID$", representationId));
    logger.info(`For the video there are ${lastPaths.length} segments to Download`)
    // TODO make chunksize flexible (but be careful with to high chunksizes, we dont want to get blocked (if orf on even does it?))
    const chunkSize = 10;
    const chunkedLastPaths = partitionArray(lastPaths, chunkSize);
    // TODO figure out how to make write stream to file work
    /*const writeStream = Writable.toWeb(fs.createWriteStream("./output", {
        autoClose: false,
    }));*/
    const file = await fs.open(filename, "as");
    let chunkCnt = 0;
    try {
        for(const chunk of chunkedLastPaths) {
            const bodyStreams = await Promise.all(chunk.map(async c => {
                const resp = await fetch(baseUrl + c);
                return resp.arrayBuffer();
            }))
            for(const z of bodyStreams) {
                await fs.appendFile(file, Buffer.from(z));
            }
            chunkCnt += chunk.length;
            logger.info("processed another " + chunk.length + " chunks. " + chunkCnt + "/" + lastPaths.length + " = " + (chunkCnt / lastPaths.length * 100).toFixed(2) + " %")
        }
    } finally {
        await file.close();
    }
}

async function main() {
    if(!args['--links']) {
        logger.error("No links to download were given");
        return;
    }
    for(const link of args['--links']) {
        logger.info(`starting procedure for ${link}`)
        const manifestUrl = await getManifestUrl(link);
        if(!manifestUrl) {
            logger.error("There was a problem retrieving the url of the manifest file. Maybe the given url is isnt a on.orf.at/video url")
            logger.error("Exiting")
            return;   
        }
        const { baseUrl, audioAdaptionSet, videoAdaptionSet } = await fetchAndParseManifestFile(manifestUrl);
        const videoRepresentation = (videoAdaptionSet.representations as VideoRepresentation[]).sort((a, b) => {
            return b.height - a.height;
        }).at(0);
        const audioRepresentation = (audioAdaptionSet.representations as AudioRepresentation[]).at(0)
        if(!videoRepresentation || !audioRepresentation) {
            return;
        }
        await Promise.all([downloadSegmentsAndSaveToFile(videoAdaptionSet, videoRepresentation.id, baseUrl, "./output"), 
                           downloadSegmentsAndSaveToFile(audioAdaptionSet, audioRepresentation.id, baseUrl, "./output_audio")]);
        // TODO merge files (audio and video into one mp4). with ffmpeg
        // TODO delete the only audio and video file
    }
}

main()