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