const optionDefinitions = [
  {
    name: 'help',
    description: 'Display this usage guide.',
    alias: 'h',
    type: Boolean
  },
  {
    name: 'src',
    description: 'The input files to process. This is some additional text existing solely to demonstrate word-wrapping, nothing more, nothing less. And nothing in between.',
    type: String,
    multiple: true,
    defaultOption: true,
    typeLabel: '{underline file} ...'
  },
  {
    name: 'timeout',
    description: 'Timeout value in ms.',
    alias: 't',
    type: Number,
    typeLabel: '{underline ms}'
  }
]

const sections = [
  {
    header: 'ORF ON Downloader',
    content: 'This programm can be used to download video media from on.orf.at'
  },
  {
    header: 'Synopsis',
    content: [
      '$ orfonDownloader [{bold options...] link1 link2 ...',
      '$ orfonDownloader -o ottoWalkesZIB.mp4 -o budSpencerZIB.mp4 https://on.orf.at/video/7982416/otto-waalkes-in-wien https://on.orf.at/video/13113850/bud-spencer-und-terence-hill-ueber-ihre-karrieren'
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
        desc: '1. A concise example. ',
        example: '$ example -t 100 lib/*.js'
      },
      {
        desc: '2. A long example. ',
        example: '$ example --timeout 100 --src lib/*.js'
      },
      {
        desc: '3. This example will scan space for unknown things. Take cure when scanning space, it could take some time. ',
        example: '$ example --src galaxy1.facts galaxy1.facts galaxy2.facts galaxy3.facts galaxy4.facts galaxy5.facts'
      }
    ]
  },
  {
    content: 'Project home: {underline https://github.com/pprzidal/orfonDownloader}'
  }
]

export { sections };