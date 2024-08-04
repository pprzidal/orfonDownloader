import { XMLParser } from 'fast-xml-parser';
import arg from 'arg';
import fs from 'node:fs/promises';
import { mapRawAdaptionSetToDs, partitionArray } from './utils';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import winston from 'winston';

const logger = winston.createLogger({
    transports: [new winston.transports.Console()]
})

const MAX_PARALLEL_REQUESTS = 20;

const args = arg({
    '-o': '--output',
    '-v': '--version',
    '-l': '--links',
    '--chunkSize': Number,
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
        if(lastManiUrl.includes("QXB.mp4")) break;
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

async function downloadSegmentsAndSaveToFile(adaptionSet: AdaptionSet, representationId: string, baseUrl: string, filename: string, chunkSize?: number) {
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
    // TODO maybe even use available ram as a measure for how many requests parrallel are acceptable
    const potentialChunkSize = Math.ceil(lastPaths.length / 10);
    chunkSize = chunkSize ? chunkSize : (potentialChunkSize < (MAX_PARALLEL_REQUESTS + 1)) ? potentialChunkSize : MAX_PARALLEL_REQUESTS;
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

async function mergeAudioAndVideo(audioPath: string, videoPath: string, outfile: string) {
    return new Promise<void>((res, rej) => {
        // TODO spawn subprocess
        const ffmpeg = spawn(os.platform() === "linux" ? path.join(__dirname, "..", "ffmpeg-master-latest-linux64-gpl", "bin", "ffmpeg") : "Sorry :(", ["-stats", "-i", videoPath, "-i", audioPath, "-c", "copy", outfile], {
            windowsHide: true,
            stdio: "inherit",
        });

        ffmpeg.on("exit", () => res());
        
        // get into stdout and print time estimation
        // await end of subprocess
    })
}

async function main() {
    if(!args['--links']) {
        logger.error("No links to download were given");
        return;
    }
    for(const link of args['--links']) {
        const [audioPath, videoPath, finalFileName] = ["./output_audio", "./output", "final.mp4"];
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
        const audioRepresentation = (audioAdaptionSet.representations as AudioRepresentation[]).sort((a, b) => b.audioSamplingRate - a.audioSamplingRate).at(0)
        if(!videoRepresentation || !audioRepresentation) {
            logger.error("");
            return;
        }
        await Promise.all([downloadSegmentsAndSaveToFile(videoAdaptionSet, videoRepresentation.id, baseUrl, videoPath, args['--chunkSize']), 
                           downloadSegmentsAndSaveToFile(audioAdaptionSet, audioRepresentation.id, baseUrl, audioPath, args['--chunkSize'])]);
        // TODO merge files (audio and video into one mp4). with ffmpeg
        // TODO delete the only audio and video file
        logger.info(`Starting to merge ${videoPath} and ${audioPath} into ${finalFileName}`);
        await mergeAudioAndVideo(audioPath, videoPath, finalFileName);
        logger.info(`Done merging audio and video into ${finalFileName}`);
        logger.info(`Deleting temp files (${videoPath}, ${audioPath} ...`);
        await Promise.all([fs.rm(videoPath), fs.rm(audioPath)]);
        logger.info(`Successful deleted temp files (${videoPath}, ${audioPath}`)
    }
}

main()