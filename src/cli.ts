const optionDefinitions = [
  {
    name: 'help',
    description: 'This option can be used to display the help (your currently viewing)',
    type: Boolean
  },
  {
    name: 'chunkSize',
    description: 'The amount of HTTP Request to send in parrallel',
    type: Number,
  },
  {
    name: 'retries',
    description: 'The amount of retries for each HTTP Request. So each HTTP Request will be executed retries + 1 times at most',
    type: Number,
  },
  {
    name: 'output',
    description: 'The name of the files in which to write the videos',
    alias: 'o',
    type: String,
  },
  {
    name: 'version',
    description: 'This Option can be used to display the version of ORF ON Downloader you use',
    alias: 'v',
    type: Boolean,
  },
  {
    name: 'ffmpegPath',
    description: 'This Option can be used when the folder containing ffmpeg isnt in the PATH Variable. You can hint ORF ON Downloader to the ffmpeg binary. For example \'... --ffmpegPath /usr/bin/ffmpeg ...\'',
    type: String,
  },
  {
    name: 'useFFMPEGPipes',
    description: 'Only available on Linux! This Option can be used to spawn ffmpeg with two pipes as input (one for audio and one for video). With this the intermediate files dont have to be persistent to the Filesystem and usually time is saved',
    type: Boolean,
  },
]

const sections = [
  {
    header: 'ORF ON Downloader',
    content: 'This programm can be used to download video media from on.orf.at'
  },
  {
    header: 'Synopsis',
    content: [
      '$ orfonDownloader [{bold options...}] link1 link2 ...',
    ]
  },
  {
    header: 'Options',
    optionList: optionDefinitions
  },
  {
    header: 'Examples',
    content: [
      {
        desc: '1. Downloading two videos and saving them in the associated files. ',
        example: '$ orfonDownloader -o ottoWalkesZIB.mp4 -o budSpencerZIB.mp4 https://on.orf.at/video/7982416/otto-waalkes-in-wien https://on.orf.at/video/13113850/bud-spencer-und-terence-hill-ueber-ihre-karrieren'
      },
      {
        desc: '2. Downloading a long video. Setting the chunkSize manually to speed things up. ',
        example: '$ orfonDownloader --chunkSize 20 -o meinRudolfsheim.mp4 https://on.orf.at/video/14024452/mein-rudolfsheim-fuenfhaus'
      }
    ]
  },
  {
    content: 'Project home: {underline https://github.com/pprzidal/orfonDownloader}'
  }
]

export { sections };