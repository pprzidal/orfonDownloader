import { Readable, Writable } from 'node:stream';
import fs, { write } from 'node:fs';

import { XMLParser } from 'fast-xml-parser';
import arg from 'arg';
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
    console.log("manifestUrl", manifestUrl);
    const resp = await fetch(manifestUrl);
    //console.log(JSON.stringify(resp, undefined, '  '));
    console.log("resp final url", resp.url);
    const baseUrl = resp.url.substring(0, resp.url.lastIndexOf("/") + 1)
    console.log("baseUrl", baseUrl);
    const asText = await resp.text();
    const parser = new XMLParser({
        //preserveOrder: true,
        parseAttributeValue: true,
        ignoreAttributes: false,
    });
    const document = parser.parse(asText);
    const adaptionSets = document.MPD.Period.AdaptationSet as Array<any>;
    const videoAdaptionSet = mapRawAdaptionSetToDs(adaptionSets.find(z => z["@_mimeType"] === "video/mp4"));
    const audioAdaptionSet = mapRawAdaptionSetToDs(adaptionSets.find(z => z["@_mimeType"] === "audio/mp4"))
    /*console.log("video\n",JSON.stringify(videoAdaptionSet, undefined, '  '));
    console.log("audio\n",JSON.stringify(audioAdaptionSet, undefined, '  '));*/
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
function partionArray<T>(arr: Array<T>, chunksize: number): Array<Array<T>> {
    const res = [];
    for (let i = 0; i < arr.length; i += chunksize) {
        const chunk = arr.slice(i, i + chunksize);
        res.push(chunk);
    }
    return res;
}

async function downloadSegmentsAndSaveToFile(adaptionSet: AdaptionSet, baseUrl: string, filename: string) {
    let time = 0;
    const lastPaths = adaptionSet.segmentTemplate.segmentTimeline.segments.flatMap((s) => {
        let reps = 1;
        if(s.r) reps += s.r;
        const agg = [];
        for(let i = 0; i < reps; i++) {
            const lastPath = (adaptionSet.segmentTemplate.media.replace("$RepresentationID$", adaptionSet.id).replace("$Time$", `${time}`));
            agg.push(lastPath);
            time += s.d;
        }
        return agg;
    });
    // also insert the init thingy
    lastPaths.unshift(adaptionSet.segmentTemplate.initialization.replace("$RepresentationID$", adaptionSet.id));
    logger.info(`For the video there are ${lastPaths.length} segments to Download`)
    // TODO make chunksize flexible (but be careful with to high chunksizes, we dont want to get blocked (if orf on even does it?))
    const chunkedLastPaths = partionArray(lastPaths, 10);
    // TODO figure out how to make write stream to file work
    /*const writeStream = Writable.toWeb(fs.createWriteStream("./output", {
        autoClose: false,
    }));*/
    for(const chunk of chunkedLastPaths) {
        const bodyStreams = await Promise.all(chunk.map(async c => {
            const resp = await fetch(baseUrl + c);
            return resp.arrayBuffer();
        }))
        for(const z of bodyStreams) {
            //if(z) await z.pipeTo(writeStream);
            fs.appendFileSync("./output", Buffer.from(z));
            logger.info("here");
        }
        /*bodyStreams.forEach(async z => {
            if(z) await z.pipeTo(writeStream)
        })*/
    }
}

async function main() {
    const manifestUrl = await getManifestUrl("https://on.orf.at/video/14235745/venus-serena-aus-dem-ghetto-nach-wimbledon");
    if(!manifestUrl) {
        logger.error("There was a problem retrieving the url of the manifest file. Maybe the given url is isnt a on.orf.at/video url")
        logger.error("Exiting")
        return;   
    }
    const { baseUrl, audioAdaptionSet, videoAdaptionSet } = await fetchAndParseManifestFile(manifestUrl);
    const representation = videoAdaptionSet.representations[0];
    downloadSegmentsAndSaveToFile(videoAdaptionSet, baseUrl, "./output");
}

main()