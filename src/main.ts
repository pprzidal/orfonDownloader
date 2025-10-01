import { XMLParser } from 'fast-xml-parser';
import arg from 'arg';
import fs from 'node:fs/promises';
import { getFinalFilenames, mapRawAdaptionSetToDs, partitionArray } from './utils';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import winston from 'winston';
import { version } from '../package.json';
import commandLineUsage from 'command-line-usage';
import { sections } from './cli';
import { PassThrough, Readable, Writable } from 'node:stream';

const logger = winston.createLogger({
    transports: [new winston.transports.Console()],
    format: winston.format.cli(),
})

const MAX_PARALLEL_REQUESTS = 20;

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

function prepareSegments(segmentTemplate: SegmentTemplate, representationId: string): string[] {
    let time = 0;
    const lastPaths = segmentTemplate.segmentTimeline.segments.flatMap((s) => {
        let reps = 1;
        if(s.r) reps += s.r;
        const agg = [];
        for(let i = 0; i < reps; i++) {
            const lastPath = (segmentTemplate.media.replace("$RepresentationID$", representationId).replace("$Time$", `${time}`));
            agg.push(lastPath);
            time += s.d;
        }
        return agg;
    });
    // also insert the init thingy
    lastPaths.unshift(segmentTemplate.initialization.replace("$RepresentationID$", representationId));
    return lastPaths;
}

async function downloadChunk(chunk: string[], baseUrl: string, purpose: "audio" | "video", attempts: number) {
    return Promise.all(chunk.map(async c => {
        let attemptsLeft = attempts;
        while(attempts > 0) {
            try {
                const resp = await fetch(baseUrl + c);
                return resp.arrayBuffer();
            } catch(ex) {
                attempts--;
                logger.debug(`${purpose},${baseUrl + c}: ${ex}`);
                logger.error(`${purpose} - failed to fetch for ${baseUrl + c}. ${attemptsLeft} attempts left.`)
            }
        }
        return Promise.reject(`${purpose} - failed to fetch for ${baseUrl + c}`);
    }));
}

async function downloadSegmentsAndSaveToFile(adaptionSet: AdaptionSet, representationId: string, baseUrl: string, filename: string, purpose: "audio" | "video", chunkSize?: number, retries?: number) {
    const lastPaths = prepareSegments(adaptionSet.segmentTemplate, representationId);
    logger.info(`For the ${purpose} there are ${lastPaths.length} segments to Download`)
    // TODO maybe even use available RAM as a measure for how many requests parrallel are acceptable
    const potentialChunkSize = Math.ceil(lastPaths.length / 10);
    chunkSize = chunkSize ?? (potentialChunkSize < (MAX_PARALLEL_REQUESTS + 1)) ? potentialChunkSize : MAX_PARALLEL_REQUESTS;
    const chunkedLastPaths = partitionArray(lastPaths, chunkSize);
    // TODO figure out how to make write stream to file work
    const file = await fs.open(filename, "as");
    let chunkCnt = 0;
    try {
        for(const chunk of chunkedLastPaths) {
            const bodyStreams = await downloadChunk(chunk, baseUrl, purpose, retries ? retries + 1 : 3);
            for(const z of bodyStreams) {
                await fs.appendFile(file, Buffer.from(z));
            }
            chunkCnt += chunk.length;
            logger.info(purpose + " - processed another " + chunk.length + " chunks. " + chunkCnt + "/" + lastPaths.length + " = " + (chunkCnt / lastPaths.length * 100).toFixed(2) + " %")
        }
    } finally {
        await file.close();
    }
}

function partition(adaptionSet: AdaptionSet, representationId: string) {
    const lastPaths = prepareSegments(adaptionSet.segmentTemplate, representationId);
    // TODO maybe even use available RAM as a measure for how many requests parrallel are acceptable
    const potentialChunkSize = Math.ceil(lastPaths.length / 10);
    const chunkSize = (potentialChunkSize < (MAX_PARALLEL_REQUESTS + 1)) ? potentialChunkSize : MAX_PARALLEL_REQUESTS;
    const chunkedLastPaths = partitionArray(lastPaths, chunkSize);
    return chunkedLastPaths;
}

function mixPartitions(source1: string[][], source1Purpose: "audio" | "video", source2: string[][], source2Purpose: "audio" | "video"): Array<{ lastPaths: string[], purpose: "audio" | "video" }> {
    const newArray = new Array(source1.length + source2.length);
    for(let i = 0, source1Cnt = 0, source2Cnt = 0; i < newArray.length; i++) {
        const even = ((i % 2) == 0);
        if((even && source1Cnt < source1.length) || (source2Cnt >= source2.length)) {
            newArray[i] = { lastPaths: source1[source1Cnt], purpose: source1Purpose }
            source1Cnt++;
        } else {
            newArray[i] = { lastPaths: source2[source2Cnt], purpose: source2Purpose }
            source2Cnt++;
        }
    }
    return newArray;
}

async function downloadSegmentsAndPutToStream(chunks: Array<{lastPaths: Array<string>, purpose: "audio" | "video"}>, baseUrl: string, audioStream: PassThrough, videoStream: PassThrough, retries?: number) {
    const chunkSizes = {
        "video": chunks.reduce((prev, cur) => (cur.purpose === "video") ? cur.lastPaths.length + prev : prev, 0),
        "audio": chunks.reduce((prev, cur) => (cur.purpose === "audio") ? cur.lastPaths.length + prev : prev, 0),
    }
    const chunkCnt = {
        "audio": 0,
        "video": 0,
    };
    try {
        for(const chunk of chunks) {
            const bodyStreams = await downloadChunk(chunk.lastPaths, baseUrl, chunk.purpose, retries ? retries + 1 : 3);
            for(const z of bodyStreams) {
                //await fs.appendFile(file, Buffer.from(z));
                if(chunk.purpose === "audio") audioStream.write(Buffer.from(z));
                else if(chunk.purpose === "video") videoStream.write(Buffer.from(z));
            }
            chunkCnt[chunk.purpose] += chunk.lastPaths.length;
            logger.info(chunk.purpose + " - processed another " + chunk.lastPaths.length + " chunks. " + chunkCnt[chunk.purpose] + "/" + chunkSizes[chunk.purpose] + " = " + (chunkCnt[chunk.purpose] / chunkSizes[chunk.purpose] * 100).toFixed(2) + " %")
        }
    } finally {
        audioStream.end();
        videoStream.end();
    }
}

async function mergeAudioAndVideoStream(outfile: string, ffmpegPath?: string): Promise<{audioStream: PassThrough, videoStream: PassThrough}> {
    const ffmpegExecutable = ffmpegPath ?? "ffmpeg";
    logger.info(`Useing ${ffmpegExecutable} as ffmpeg`);
    const audioStream = new PassThrough();
    const videoStream = new PassThrough();
    return new Promise((res, rej) => {
        const ffmpeg = spawn(ffmpegExecutable, ["-stats", "-loglevel", "error", "-i", "pipe:3", "-i", "pipe:4", "-c", "copy", outfile], {
            windowsHide: true,
            stdio: ['inherit', 'inherit', 'inherit', 'pipe', 'pipe'],
            timeout: 120_000,
        });

        audioStream.pipe(ffmpeg.stdio[3] as Writable);
        videoStream.pipe(ffmpeg.stdio[4] as Writable);

        ffmpeg.on("error", (err: Error) => {
            rej(err);
        })

        ffmpeg.on("exit", () => {
            audioStream.unpipe();
            videoStream.unpipe();
            logger.info("ffmpeg Merging done");
        });

        ffmpeg.on("spawn", () => res({audioStream, videoStream}));
    })
}

async function mergeAudioAndVideo(audioPath: string, videoPath: string, outfile: string, ffmpegPath?: string) {
    const ffmpegExecutable = ffmpegPath ?? "ffmpeg";
    logger.info(`Useing ${ffmpegExecutable} as ffmpeg`);
    return new Promise<void>((res, rej) => {
        const ffmpeg = spawn(ffmpegExecutable, ["-stats", "-loglevel", "error", "-i", videoPath, "-i", audioPath, "-c", "copy", outfile], {
            windowsHide: true,
            stdio: 'inherit',
        });

        ffmpeg.on("error", (err: Error) => {
            rej(err);
        })

        ffmpeg.on("exit", () => res());
    })
}

async function persistAndMergeSequentially(videoAdaptionSet: AdaptionSet, audioAdaptionSet: AdaptionSet, videoRepresentation: VideoRepresentation, audioRepresentation: AudioRepresentation, 
                                            baseUrl: string, videoPath: string, audioPath: string, finalFileName: string, args: arg.Result<any>) {
    await Promise.all([downloadSegmentsAndSaveToFile(videoAdaptionSet, videoRepresentation.id, baseUrl, videoPath, "video", args['--chunkSize'], args['--retries']), 
                        downloadSegmentsAndSaveToFile(audioAdaptionSet, audioRepresentation.id, baseUrl, audioPath, "audio", args['--chunkSize'], args['--retries'])]);
    logger.info(`Starting to merge ${videoPath} and ${audioPath} into ${finalFileName}`);
    try {
        await mergeAudioAndVideo(audioPath, videoPath, finalFileName, args['--ffmpegPath']);
        logger.info(`Done merging audio and video into ${finalFileName}`);
    } catch(err) {
        logger.error(err);
    }
}

async function pipeIntoFFMPEG(videoAdaptionSet: AdaptionSet, audioAdaptionSet: AdaptionSet, videoRepresentation: VideoRepresentation, audioRepresentation: AudioRepresentation, 
                                baseUrl: string, finalFileName: string, args: arg.Result<any>) {
    const [lastPathsVideo, lastPathsAudio] = [partition(videoAdaptionSet, videoRepresentation.id), partition(audioAdaptionSet, audioRepresentation.id)];
    const mixedParts = mixPartitions(lastPathsVideo, "video", lastPathsAudio, "audio");
    const { audioStream, videoStream } = await mergeAudioAndVideoStream(finalFileName, args['--ffmpegPath']);
    await downloadSegmentsAndPutToStream(mixedParts, baseUrl, audioStream, videoStream);
}

async function main() {
    const args = arg({
        '-o': [String],
        '--chunkSize': Number,
        '--retries': Number,
        '--ffmpegPath': String,
        '--verbose': Boolean,
        '--help': Boolean,
        '--version': Boolean,
        '--useFFMPEGPipes': Boolean,
    
        '-v': '--version',
    })

    if(args['--version']) {
        console.log(`You are useing ORF ON Downloader Version v${version}`)
        return;
    }

    if((!args._) || args['--help'] || args._.length == 0) {
        console.log(commandLineUsage(sections));
        return;
    }

    const fileNames = getFinalFilenames(args._.length, args['-o']);
    for(const [i, link] of args._.entries()) {
        const [audioPath, videoPath, finalFileName] = ["./output_audio", "./output", fileNames[i]];
        logger.info(`Starting procedure ${i + 1} of ${args._.length} for ${link} and trying to save it to ${finalFileName}`)
        const manifestUrl = await getManifestUrl(link);
        if(!manifestUrl) {
            logger.error(`There was a problem retrieving the url of the manifest file for ${link}. Maybe the given url is isnt a on.orf.at/video url`)
            continue;
        }
        const { baseUrl, audioAdaptionSet, videoAdaptionSet } = await fetchAndParseManifestFile(manifestUrl);
        const videoRepresentation = (videoAdaptionSet.representations as VideoRepresentation[]).sort((a, b) => {
            return b.height - a.height;
        }).at(0)!;
        const audioRepresentation = (audioAdaptionSet.representations as AudioRepresentation[]).sort((a, b) => b.audioSamplingRate - a.audioSamplingRate).at(0)!;

        if(args['--useFFMPEGPipes']) {
            await pipeIntoFFMPEG(videoAdaptionSet, audioAdaptionSet, videoRepresentation, audioRepresentation, baseUrl, finalFileName, args);
        } else {
            await persistAndMergeSequentially(videoAdaptionSet, audioAdaptionSet, videoRepresentation, audioRepresentation, baseUrl, videoPath, audioPath, finalFileName, args);
            
            // cleanup temporary files
            logger.info(`Deleting temp files (${videoPath}, ${audioPath}) ...`);
            await Promise.all([fs.rm(videoPath), fs.rm(audioPath)]);
            logger.info(`Successful deleted temp files (${videoPath}, ${audioPath})`);
        }
        console.log();
    }
}

main()