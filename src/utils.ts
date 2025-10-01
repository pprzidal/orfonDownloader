import path from "node:path";
import fs from 'node:fs/promises';
import os from "node:os";

/**
 * some pretty good garbage code
 * @param adaptionSetRaw 
 * @returns 
 */
export function mapRawAdaptionSetToDs(adaptionSetRaw: any): AdaptionSet {
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
                ...(t["@_audioSamplingRate"] ? {audioSamplingRate: t["@_audioSamplingRate"]} : {}),
                ...(t["@_width"] ? {width: t["@_width"]} : {}),
                ...(t["@_height"] ? {height: t["@_height"]} : {}),
            } as Representation;
        })
    } else {
        representations = [{
            id: adaptionSetRaw["Representation"]["@_id"],
            codecs: adaptionSetRaw["Representation"]["@_codecs"] as string,
            ...(adaptionSetRaw["Representation"]["@_audioSamplingRate"] ? {audioSamplingRate: adaptionSetRaw["Representation"]["@_audioSamplingRate"]} : {}),
            ...(adaptionSetRaw["Representation"]["@_width"] ? {width: adaptionSetRaw["Representation"]["@_width"]} : {}),
            ...(adaptionSetRaw["Representation"]["@_height"] ? {height: adaptionSetRaw["Representation"]["@_height"]} : {}),
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
export function partitionArray<T>(arr: Array<T>, chunksize: number): Array<Array<T>> {
    const res = [];
    for (let i = 0; i < arr.length; i += chunksize) {
        const chunk = arr.slice(i, i + chunksize);
        res.push(chunk);
    }
    return res;
}

function generateArray(amount: number, fromIdxToFilename: (idx: number) => string, offset?: number): string[] {
    const arr = new Array<string>(amount);
    for(let i = 0; i < arr.length; i++) arr[i] = fromIdxToFilename(i + (offset ?? 0));
    return arr;
}

export function getFinalFilenames(amount: number, names?: string[], fileNameFromIdx = (idx: number) => `final${idx}.mp4`): string[] {
    if(names) {
        let arr = names;
        if(names.length == 1 && names[0].includes(',')) {
            arr = names[0].split(',');
        }
        return [...arr, ...generateArray(amount - arr.length, fileNameFromIdx, (amount - arr.length) + 1)]

    }
    return generateArray(amount, fileNameFromIdx);
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