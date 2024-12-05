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

/**
 * CURRENTLY NOT USED. Downloads ffmpeg and writes it to a directory for the current user.
 * @param folderPath 
 * @returns the path to the freshly installed ffmpeg binary
 */
async function installFFMPEG(folderPath: string): Promise<string> {
    const downloadLinks = {
        "linux": "https://www.johnvansickle.com/ffmpeg/old-releases/ffmpeg-6.0-amd64-static.tar.xz",
        "win32": "https://github.com/GyanD/codexffmpeg/releases/download/6.0/ffmpeg-6.0-essentials_build.zip",
        "darwin": "https://evermeet.cx/pub/ffmpeg/ffmpeg-6.0.zip",
    };

    if(!["linux", "win32", "darwin"].includes(os.platform())) throw `ORF ON Downloader doesnt support ${os.platform()}`;

    const orfOnDownloaderPath = path.join(os.homedir(), ".orfOnDownloader");
    await fs.mkdir(orfOnDownloaderPath, { recursive: true });

    const resp = await fetch(downloadLinks[os.platform() as "linux" | "win32" | "darwin"])
    const ffmpegZip = path.join(orfOnDownloaderPath, "ffmpegDownload");
    fs.writeFile(ffmpegZip, Buffer.from(await resp.arrayBuffer()));

    // TODO unzip
    const unpackCommands = {
        "linux": "https://www.johnvansickle.com/ffmpeg/old-releases/ffmpeg-6.0-amd64-static.tar.xz",
        "win32": "https://github.com/GyanD/codexffmpeg/releases/download/6.0/ffmpeg-6.0-essentials_build.zip",
        "darwin": ["unzip", ffmpegZip, "-d", "ffmpeg"],
    }

    return "";
}

async function mergeAudioAndVideo(audioPath: string, videoPath: string, outfile: string, ffmpegPath?: string) {
    const ffmpegExecutable = ffmpegPath ?? "ffmpeg";
    logger.info(`Useing ${ffmpegExecutable} as ffmpeg`);
    return new Promise<void>((res, rej) => {
        const ffmpeg = spawn(ffmpegExecutable, ["-stats", "-i", videoPath, "-i", audioPath, "-c", "copy", outfile], {
            windowsHide: true,
        });

        ffmpeg.on("error", (err: Error) => {
            rej(err);
        })

        ffmpeg.on("exit", () => res());
    })
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
        await Promise.all([downloadSegmentsAndSaveToFile(videoAdaptionSet, videoRepresentation.id, baseUrl, videoPath, "video", args['--chunkSize'], args['--retries']), 
                           downloadSegmentsAndSaveToFile(audioAdaptionSet, audioRepresentation.id, baseUrl, audioPath, "audio", args['--chunkSize'], args['--retries'])]);
        logger.info(`Starting to merge ${videoPath} and ${audioPath} into ${finalFileName}`);
        try {
            await mergeAudioAndVideo(audioPath, videoPath, finalFileName, args['--ffmpegPath']);
            logger.info(`Done merging audio and video into ${finalFileName}`);
        } catch(err) {
            logger.error(err);
        }
        logger.info(`Deleting temp files (${videoPath}, ${audioPath}) ...`);
        await Promise.all([fs.rm(videoPath), fs.rm(audioPath)]);
        logger.info(`Successful deleted temp files (${videoPath}, ${audioPath})`);
        console.log(`${os.EOL}${os.EOL}`);
    }
}

main()