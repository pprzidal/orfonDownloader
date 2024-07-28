type Representation = AudioRepresentation | VideoRepresentation;

interface AudioRepresentation {
    id: string,
    codecs: string,
    audioSamplingRate: string,
}

interface VideoRepresentation {
    id: string,
    codecs: string,
    width: number,
    height: number,
}

interface S {
    t: number?,
    d: number,
    r: number?,
}

interface SegmentTimeline {
    segments: S[]
}

interface SegmentTemplate {
    initialization: string,
    media: string,
    segmentTimeline: SegmentTimeline,
}

interface AdaptionSet {
    id: string,
    group: string,
    mimeType: string,
    representations: Representation[],
    segmentTemplate: SegmentTemplate,
}

interface Period {
    adaptionSets: AdaptionSet[]
}