const _ = require('lodash')
const R = require('ramda')
const path = require('path')
const Promise = require('bluebird')
const deepDiff = require('return-deep-diff')
const errors = require('./errors')
const scaffold = require('./scaffold')
const fs = require('./util/fs')
const keys = require('./util/keys')
const origin = require('./util/origin')
const coerce = require('./util/coerce')
const settings = require('./util/settings')
const v = require('./util/validation')
const debug = require('debug')('cypress:server:config')
const pathHelpers = require('./util/path_helpers')
const findSystemNode = require('./util/find_system_node')

const CYPRESS_ENV_PREFIX = 'CYPRESS_'
const CYPRESS_ENV_PREFIX_LENGTH = 'CYPRESS_'.length
const CYPRESS_RESERVED_ENV_VARS = [
  'CYPRESS_INTERNAL_ENV',
]
const CYPRESS_SPECIAL_ENV_VARS = [
  'CI_KEY',
  'RECORD_KEY',
]

const dashesOrUnderscoresRe = /^(_-)+/
const oneOrMoreSpacesRe = /\s+/

const toWords = (str) => {
  return str.trim().split(oneOrMoreSpacesRe)
}

const isCypressEnvLike = (key) => {
  return _.chain(key)
  .invoke('toUpperCase')
  .startsWith(CYPRESS_ENV_PREFIX)
  .value() &&
  !_.includes(CYPRESS_RESERVED_ENV_VARS, key)
}

const removeEnvPrefix = (key) => {
  return key.slice(CYPRESS_ENV_PREFIX_LENGTH)
}

const folders = toWords(`\
fileServerFolder   fixturesFolder   integrationFolder   pluginsFile
screenshotsFolder  supportFile      supportFolder       unitFolder
videosFolder\
`)

// for experimentalComponentTesting
folders.push('componentFolder')

// Public configuration properties, like "cypress.json" fields
const configKeys = toWords(`\
animationDistanceThreshold      fileServerFolder
baseUrl                         fixturesFolder
blockHosts
chromeWebSecurity
modifyObstructiveCode           integrationFolder
env                             pluginsFile
hosts                           screenshotsFolder
numTestsKeptInMemory            supportFile
port                            supportFolder
projectId                       videosFolder
reporter
reporterOptions
ignoreTestFiles
testFiles                       defaultCommandTimeout
trashAssetsBeforeRuns           execTimeout
userAgent                       pageLoadTimeout
viewportWidth                   requestTimeout
viewportHeight                  responseTimeout
video                           taskTimeout
videoCompression
videoUploadOnPasses
screenshotOnRunFailure
watchForFileChanges
waitForAnimations               resolvedNodeVersion
nodeVersion                     resolvedNodePath
firefoxGcInterval
retries
`)

// NOTE: If you add a config value, make sure to update the following
// - cli/types/index.d.ts (including allowed config options on TestOptions)
// - cypress.schema.json

// experimentalComponentTesting
configKeys.push('componentFolder')

// Breaking public configuration properties, will error
const breakingConfigKeys = toWords(`\
blacklistHosts
videoRecording
screenshotOnHeadlessFailure
trashAssetsBeforeHeadlessRuns
experimentalGetCookiesSameSite\
`)

// Internal configuration properties the user should be able to overwrite
const systemConfigKeys = toWords(`\
browsers\
`)

// Know experimental flags / values
// each should start with "experimental" and be camel cased
// example: experimentalComponentTesting
const experimentalConfigKeys = [
  'experimentalSourceRewriting',
  'experimentalComponentTesting',
  'experimentalShadowDomSupport',
  'experimentalFetchPolyfill',
  'experimentalNetworkStubbing',
]

const CONFIG_DEFAULTS = {
  port: null,
  hosts: null,
  morgan: true,
  baseUrl: null,
  // will be replaced by detected list of browsers
  browsers: [],
  socketId: null,
  projectId: null,
  userAgent: null,
  isTextTerminal: false,
  reporter: 'spec',
  reporterOptions: null,
  blockHosts: null,
  clientRoute: '/__/',
  xhrRoute: '/xhrs/',
  socketIoRoute: '/__socket.io',
  socketIoCookie: '__socket.io',
  reporterRoute: '/__cypress/reporter',
  ignoreTestFiles: '*.hot-update.js',
  testFiles: '**/*.*',
  defaultCommandTimeout: 4000,
  requestTimeout: 5000,
  responseTimeout: 30000,
  pageLoadTimeout: 60000,
  execTimeout: 60000,
  taskTimeout: 60000,
  video: true,
  videoCompression: 32,
  videoUploadOnPasses: true,
  screenshotOnRunFailure: true,
  modifyObstructiveCode: true,
  chromeWebSecurity: true,
  waitForAnimations: true,
  animationDistanceThreshold: 5,
  numTestsKeptInMemory: 50,
  watchForFileChanges: true,
  trashAssetsBeforeRuns: true,
  autoOpen: false,
  viewportWidth: 1000,
  viewportHeight: 660,
  fileServerFolder: '',
  videosFolder: 'cypress/videos',
  supportFile: 'cypress/support',
  fixturesFolder: 'cypress/fixtures',
  integrationFolder: 'cypress/integration',
  screenshotsFolder: 'cypress/screenshots',
  namespace: '__cypress',
  pluginsFile: 'cypress/plugins',
  nodeVersion: 'default',
  configFile: 'cypress.json',
  firefoxGcInterval: { runMode: 1, openMode: null },

  // deprecated
  javascripts: [],

  // setting related to component testing experiments
  componentFolder: 'cypress/component',

  // experimental keys (should all start with "experimental" prefix)
  experimentalComponentTesting: false,
  experimentalSourceRewriting: false,
  experimentalNetworkStubbing: false,
  experimentalShadowDomSupport: false,
  experimentalFetchPolyfill: false,
  retries: { runMode: 0, openMode: 0 },
}

const validationRules = {
  animationDistanceThreshold: v.isNumber,
  baseUrl: v.isFullyQualifiedUrl,
  blockHosts: v.isStringOrArrayOfStrings,
  browsers: v.isValidBrowserList,
  chromeWebSecurity: v.isBoolean,
  configFile: v.isStringOrFalse,
  defaultCommandTimeout: v.isNumber,
  env: v.isPlainObject,
  execTimeout: v.isNumber,
  fileServerFolder: v.isString,
  fixturesFolder: v.isStringOrFalse,
  ignoreTestFiles: v.isStringOrArrayOfStrings,
  integrationFolder: v.isString,
  modifyObstructiveCode: v.isBoolean,
  nodeVersion: v.isOneOf('default', 'bundled', 'system'),
  numTestsKeptInMemory: v.isNumber,
  pageLoadTimeout: v.isNumber,
  pluginsFile: v.isStringOrFalse,
  port: v.isNumber,
  reporter: v.isString,
  requestTimeout: v.isNumber,
  responseTimeout: v.isNumber,
  supportFile: v.isStringOrFalse,
  taskTimeout: v.isNumber,
  testFiles: v.isStringOrArrayOfStrings,
  trashAssetsBeforeRuns: v.isBoolean,
  userAgent: v.isString,
  video: v.isBoolean,
  videoCompression: v.isNumberOrFalse,
  videosFolder: v.isString,
  videoUploadOnPasses: v.isBoolean,
  screenshotOnRunFailure: v.isBoolean,
  viewportHeight: v.isNumber,
  viewportWidth: v.isNumber,
  waitForAnimations: v.isBoolean,
  watchForFileChanges: v.isBoolean,
  firefoxGcInterval: v.isValidFirefoxGcInterval,
  componentFolder: v.isStringOrFalse,
  // experimental flag validation below
  experimentalComponentTesting: v.isBoolean,
  experimentalSourceRewriting: v.isBoolean,
  experimentalNetworkStubbing: v.isBoolean,
  experimentalShadowDomSupport: v.isBoolean,
  experimentalFetchPolyfill: v.isBoolean,
  retries: v.isValidRetriesConfig,
}

const convertRelativeToAbsolutePaths = (projectRoot, obj, defaults = {}) => {
  return _.reduce(folders, (memo, folder) => {
    const val = obj[folder]

    if ((val != null) && (val !== false)) {
      memo[folder] = path.resolve(projectRoot, val)
    }

    return memo
  }
  , {})
}

const validateNoBreakingConfig = (cfg) => {
  return _.each(breakingConfigKeys, (key) => {
    if (_.has(cfg, key)) {
      switch (key) {
        case 'screenshotOnHeadlessFailure':
          return errors.throw('SCREENSHOT_ON_HEADLESS_FAILURE_REMOVED')
        case 'trashAssetsBeforeHeadlessRuns':
          return errors.throw('RENAMED_CONFIG_OPTION', key, 'trashAssetsBeforeRuns')
        case 'videoRecording':
          return errors.throw('RENAMED_CONFIG_OPTION', key, 'video')
        case 'blacklistHosts':
          return errors.throw('RENAMED_CONFIG_OPTION', key, 'blockHosts')
        case 'experimentalGetCookiesSameSite':
          return errors.warning('EXPERIMENTAL_SAMESITE_REMOVED')
        default:
          throw new Error(`unknown breaking config key ${key}`)
      }
    }
  })
}

const validate = (cfg, onErr) => {
  return _.each(cfg, (value, key) => {
  // does this key have a validation rule?
    let validationFn

    validationFn = validationRules[key]

    if (validationFn) {
    // and is the value different from the default?
      if (value !== CONFIG_DEFAULTS[key]) {
        const result = validationFn(key, value)

        if (result !== true) {
          return onErr(result)
        }
      }
    }
  })
}

const validateFile = (file) => {
  return (settings) => {
    return validate(settings, (errMsg) => {
      return errors.throw('SETTINGS_VALIDATION_ERROR', file, errMsg)
    })
  }
}

const hideSpecialVals = function (val, key) {
  if (_.includes(CYPRESS_SPECIAL_ENV_VARS, key)) {
    return keys.hide(val)
  }

  return val
}

// an object with a few utility methods
// for easy stubbing from unit tests
const utils = {
  resolveModule (name) {
    return require.resolve(name)
  },

  // tries to find support or plugins file
  // returns:
  //   false - if the file should not be set
  //   string - found filename
  //   null - if there is an error finding the file
  discoverModuleFile (options) {
    debug('discover module file %o', options)
    const { filename, isDefault } = options

    if (!isDefault) {
      // they have it explicitly set, so it should be there
      return fs.pathExists(filename)
      .then((found) => {
        if (found) {
          debug('file exists, assuming it will load')

          return filename
        }

        debug('could not find %o', { filename })

        return null
      })
    }

    // support or plugins file doesn't exist on disk?
    debug(`support file is default, check if ${path.dirname(filename)} exists`)

    return fs.pathExists(filename)
    .then((found) => {
      if (found) {
        debug('is there index.ts in the support or plugins folder %s?', filename)
        const tsFilename = path.join(filename, 'index.ts')

        return fs.pathExists(tsFilename)
        .then((foundTsFile) => {
          if (foundTsFile) {
            debug('found index TS file %s', tsFilename)

            return tsFilename
          }

          // if the directory exists, set it to false so it's ignored
          debug('setting support or plugins file to false')

          return false
        })
      }

      debug('folder does not exist, set to default index.js')

      // otherwise, set it up to be scaffolded later
      return path.join(filename, 'index.js')
    })
  },
}

module.exports = {
  utils,

  getConfigKeys () {
    return configKeys.concat(experimentalConfigKeys)
  },

  isValidCypressInternalEnvValue (value) {
    // names of config environments, see "config/app.yml"
    const names = ['development', 'test', 'staging', 'production']

    return _.includes(names, value)
  },

  allowed (obj = {}) {
    const propertyNames = configKeys
    .concat(breakingConfigKeys)
    .concat(systemConfigKeys)
    .concat(experimentalConfigKeys)

    return _.pick(obj, propertyNames)
  },

  get (projectRoot, options = {}) {
    return Promise.all([
      settings.read(projectRoot, options).then(validateFile('cypress.json')),
      settings.readEnv(projectRoot).then(validateFile('cypress.env.json')),
    ])
    .spread((settings, envFile) => {
      return this.set({
        projectName: this.getNameFromRoot(projectRoot),
        projectRoot,
        config: settings,
        envFile,
        options,
      })
    })
  },

  set (obj = {}) {
    debug('setting config object')
    let { projectRoot, projectName, config, envFile, options } = obj

    // just force config to be an object
    // so we dont have to do as much
    // work in our tests
    if (config == null) {
      config = {}
    }

    debug('config is %o', config)

    // flatten the object's properties
    // into the master config object
    config.envFile = envFile
    config.projectRoot = projectRoot
    config.projectName = projectName

    return this.mergeDefaults(config, options)
  },

  mergeDefaults (config = {}, options = {}) {
    let url
    const resolved = {}

    _.extend(config, _.pick(options, 'configFile', 'morgan', 'isTextTerminal', 'socketId', 'report', 'browsers'))
    debug('merged config with options, got %o', config)

    _
    .chain(this.allowed(options))
    .omit('env')
    .omit('browsers')
    .each((val, key) => {
      resolved[key] = 'cli'
      config[key] = val
    }).value()

    url = config.baseUrl

    if (url) {
      // replace multiple slashes at the end of string to single slash
      // so http://localhost/// will be http://localhost/
      // https://regexr.com/48rvt
      config.baseUrl = url.replace(/\/\/+$/, '/')
    }

    _.defaults(config, CONFIG_DEFAULTS)

    // split out our own app wide env from user env variables
    // and delete envFile
    config.env = this.parseEnv(config, options.env, resolved)

    config.cypressEnv = process.env['CYPRESS_INTERNAL_ENV']
    debug('using CYPRESS_INTERNAL_ENV %s', config.cypressEnv)
    if (!this.isValidCypressInternalEnvValue(config.cypressEnv)) {
      errors.throw('INVALID_CYPRESS_INTERNAL_ENV', config.cypressEnv)
    }

    delete config.envFile

    // when headless
    if (config.isTextTerminal && !process.env.CYPRESS_INTERNAL_FORCE_FILEWATCH) {
      // dont ever watch for file changes
      config.watchForFileChanges = false

      // and forcibly reset numTestsKeptInMemory
      // to zero
      config.numTestsKeptInMemory = 0
    }

    config = this.setResolvedConfigValues(config, CONFIG_DEFAULTS, resolved)

    if (config.port) {
      config = this.setUrls(config)
    }

    config = this.setAbsolutePaths(config, CONFIG_DEFAULTS)

    config = this.setParentTestsPaths(config)

    // validate config again here so that we catch
    // configuration errors coming from the CLI overrides
    // or env var overrides
    validate(config, (errMsg) => {
      return errors.throw('CONFIG_VALIDATION_ERROR', errMsg)
    })

    validateNoBreakingConfig(config)

    return this.setSupportFileAndFolder(config)
    .then(this.setPluginsFile)
    .then(this.setScaffoldPaths)
    .then(_.partialRight(this.setNodeBinary, options.onWarning))
  },

  setResolvedConfigValues (config, defaults, resolved) {
    const obj = _.clone(config)

    obj.resolved = this.resolveConfigValues(config, defaults, resolved)
    debug('resolved config is %o', obj.resolved.browsers)

    return obj
  },

  // Given an object "resolvedObj" and a list of overrides in "obj"
  // marks all properties from "obj" inside "resolvedObj" using
  // {value: obj.val, from: "plugin"}
  setPluginResolvedOn (resolvedObj, obj) {
    return _.each(obj, (val, key) => {
      if (_.isObject(val) && !_.isArray(val) && resolvedObj[key]) {
        // recurse setting overrides
        // inside of this nested objected
        return this.setPluginResolvedOn(resolvedObj[key], val)
      }

      resolvedObj[key] = {
        value: val,
        from: 'plugin',
      }
    })
  },

  updateWithPluginValues (cfg, overrides) {
    if (!overrides) {
      overrides = {}
    }

    debug('updateWithPluginValues %o', { cfg, overrides })

    // make sure every option returned from the plugins file
    // passes our validation functions
    validate(overrides, (errMsg) => {
      if (cfg.pluginsFile && cfg.projectRoot) {
        const relativePluginsPath = path.relative(cfg.projectRoot, cfg.pluginsFile)

        return errors.throw('PLUGINS_CONFIG_VALIDATION_ERROR', relativePluginsPath, errMsg)
      }

      return errors.throw('CONFIG_VALIDATION_ERROR', errMsg)
    })

    let originalResolvedBrowsers = cfg && cfg.resolved && cfg.resolved.browsers && R.clone(cfg.resolved.browsers)

    if (!originalResolvedBrowsers) {
      // have something to resolve with if plugins return nothing
      originalResolvedBrowsers = {
        value: cfg.browsers,
        from: 'default',
      }
    }

    const diffs = deepDiff(cfg, overrides, true)

    debug('config diffs %o', diffs)

    const userBrowserList = diffs && diffs.browsers && R.clone(diffs.browsers)

    if (userBrowserList) {
      debug('user browser list %o', userBrowserList)
    }

    // for each override go through
    // and change the resolved values of cfg
    // to point to the plugin
    if (diffs) {
      debug('resolved config before diffs %o', cfg.resolved)
      this.setPluginResolvedOn(cfg.resolved, diffs)
      debug('resolved config object %o', cfg.resolved)
    }

    // merge cfg into overrides
    const merged = _.defaultsDeep(diffs, cfg)

    debug('merged config object %o', merged)

    // the above _.defaultsDeep combines arrays,
    // if diffs.browsers = [1] and cfg.browsers = [1, 2]
    // then the merged result merged.browsers = [1, 2]
    // which is NOT what we want
    if (Array.isArray(userBrowserList) && userBrowserList.length) {
      merged.browsers = userBrowserList
      merged.resolved.browsers.value = userBrowserList
    }

    if (overrides.browsers === null) {
      // null breaks everything when merging lists
      debug('replacing null browsers with original list %o', originalResolvedBrowsers)
      merged.browsers = cfg.browsers
      if (originalResolvedBrowsers) {
        merged.resolved.browsers = originalResolvedBrowsers
      }
    }

    debug('merged plugins config %o', merged)

    return merged
  },

  // combines the default configuration object with values specified in the
  // configuration file like "cypress.json". Values in configuration file
  // overwrite the defaults.
  resolveConfigValues (config, defaults, resolved = {}) {
    // pick out only known configuration keys
    return _
    .chain(config)
    .pick(configKeys.concat(systemConfigKeys).concat(experimentalConfigKeys))
    .mapValues((val, key) => {
      let r
      const source = (s) => {
        return {
          value: val,
          from: s,
        }
      }

      r = resolved[key]

      if (r) {
        if (_.isObject(r)) {
          return r
        }

        return source(r)
      }

      if (!(!_.isEqual(config[key], defaults[key]) && key !== 'browsers')) {
        // "browsers" list is special, since it is dynamic by default
        // and can only be ovewritten via plugins file
        return source('default')
      }

      return source('config')
    }).value()
  },

  // instead of the built-in Node process, specify a path to 3rd party Node
  setNodeBinary: Promise.method((obj, onWarning) => {
    if (obj.nodeVersion !== 'system') {
      obj.resolvedNodeVersion = process.versions.node

      return obj
    }

    return findSystemNode.findNodePathAndVersion()
    .then(({ path, version }) => {
      obj.resolvedNodePath = path
      obj.resolvedNodeVersion = version
    }).catch((err) => {
      onWarning(errors.get('COULD_NOT_FIND_SYSTEM_NODE', process.versions.node))
      obj.resolvedNodeVersion = process.versions.node
    }).return(obj)
  }),

  setScaffoldPaths (obj) {
    obj = _.clone(obj)

    obj.integrationExampleName = scaffold.integrationExampleName()
    obj.integrationExamplePath = path.join(obj.integrationFolder, obj.integrationExampleName)

    debug('set scaffold paths')

    return scaffold.fileTree(obj)
    .then((fileTree) => {
      debug('got file tree')
      obj.scaffoldedFiles = fileTree

      return obj
    })
  },

  // async function
  setSupportFileAndFolder (obj) {
    if (!obj.supportFile) {
      return Promise.resolve(obj)
    }

    obj = _.clone(obj)

    // TODO move this logic to find support file into util/path_helpers
    const sf = obj.supportFile

    debug(`setting support file ${sf}`)
    debug(`for project root ${obj.projectRoot}`)

    return Promise
    .try(() => {
      // resolve full path with extension
      obj.supportFile = utils.resolveModule(sf)

      return debug('resolved support file %s', obj.supportFile)
    }).then(() => {
      if (pathHelpers.checkIfResolveChangedRootFolder(obj.supportFile, sf)) {
        debug('require.resolve switched support folder from %s to %s', sf, obj.supportFile)
        // this means the path was probably symlinked, like
        // /tmp/foo -> /private/tmp/foo
        // which can confuse the rest of the code
        // switch it back to "normal" file
        obj.supportFile = path.join(sf, path.basename(obj.supportFile))

        return fs.pathExists(obj.supportFile)
        .then((found) => {
          if (!found) {
            errors.throw('SUPPORT_FILE_NOT_FOUND', obj.supportFile, obj.configFile || CONFIG_DEFAULTS.configFile)
          }

          return debug('switching to found file %s', obj.supportFile)
        })
      }
    }).catch({ code: 'MODULE_NOT_FOUND' }, () => {
      debug('support JS module %s does not load', sf)

      const loadingDefaultSupportFile = sf === path.resolve(obj.projectRoot, CONFIG_DEFAULTS.supportFile)

      return utils.discoverModuleFile({
        filename: sf,
        isDefault: loadingDefaultSupportFile,
        projectRoot: obj.projectRoot,
      })
      .then((result) => {
        if (result === null) {
          const configFile = obj.configFile || CONFIG_DEFAULTS.configFile

          return errors.throw('SUPPORT_FILE_NOT_FOUND', path.resolve(obj.projectRoot, sf), configFile)
        }

        debug('setting support file to %o', { result })
        obj.supportFile = result

        return obj
      })
    })
    .then(() => {
      if (obj.supportFile) {
        // set config.supportFolder to its directory
        obj.supportFolder = path.dirname(obj.supportFile)
        debug(`set support folder ${obj.supportFolder}`)
      }

      return obj
    })
  },

  // set pluginsFile to an absolute path with the following rules:
  // - do nothing if pluginsFile is falsey
  // - look up the absolute path via node, so 'cypress/plugins' can resolve
  //   to 'cypress/plugins/index.js' or 'cypress/plugins/index.coffee'
  // - if not found
  //   * and the pluginsFile is set to the default
  //     - and the path to the pluginsFile directory exists
  //       * assume the user doesn't need a pluginsFile, set it to false
  //         so it's ignored down the pipeline
  //     - and the path to the pluginsFile directory does not exist
  //       * set it to cypress/plugins/index.js, it will get scaffolded
  //   * and the pluginsFile is NOT set to the default
  //     - throw an error, because it should be there if the user
  //       explicitly set it
  setPluginsFile: Promise.method((obj) => {
    if (!obj.pluginsFile) {
      return obj
    }

    obj = _.clone(obj)

    const {
      pluginsFile,
    } = obj

    debug(`setting plugins file ${pluginsFile}`)
    debug(`for project root ${obj.projectRoot}`)

    return Promise
    .try(() => {
      // resolve full path with extension
      obj.pluginsFile = utils.resolveModule(pluginsFile)

      return debug(`set pluginsFile to ${obj.pluginsFile}`)
    }).catch({ code: 'MODULE_NOT_FOUND' }, () => {
      debug('plugins module does not exist %o', { pluginsFile })

      const isLoadingDefaultPluginsFile = pluginsFile === path.resolve(obj.projectRoot, CONFIG_DEFAULTS.pluginsFile)

      return utils.discoverModuleFile({
        filename: pluginsFile,
        isDefault: isLoadingDefaultPluginsFile,
        projectRoot: obj.projectRoot,
      })
      .then((result) => {
        if (result === null) {
          return errors.throw('PLUGINS_FILE_ERROR', path.resolve(obj.projectRoot, pluginsFile))
        }

        debug('setting plugins file to %o', { result })
        obj.pluginsFile = result

        return obj
      })
    }).return(obj)
  }),

  setParentTestsPaths (obj) {
    // projectRoot:              "/path/to/project"
    // integrationFolder:        "/path/to/project/cypress/integration"
    // componentFolder:          "/path/to/project/cypress/components"
    // parentTestsFolder:        "/path/to/project/cypress"
    // parentTestsFolderDisplay: "project/cypress"

    obj = _.clone(obj)

    const ptfd = (obj.parentTestsFolder = path.dirname(obj.integrationFolder))

    const prd = path.dirname(obj.projectRoot != null ? obj.projectRoot : '')

    obj.parentTestsFolderDisplay = path.relative(prd, ptfd)

    return obj
  },

  setAbsolutePaths (obj, defaults) {
    let pr

    obj = _.clone(obj)

    // if we have a projectRoot
    pr = obj.projectRoot

    if (pr) {
      // reset fileServerFolder to be absolute
      // obj.fileServerFolder = path.resolve(pr, obj.fileServerFolder)

      // and do the same for all the rest
      _.extend(obj, convertRelativeToAbsolutePaths(pr, obj, defaults))
    }

    return obj
  },

  setUrls (obj) {
    obj = _.clone(obj)

    const proxyUrl = `http://localhost:${obj.port}`

    const rootUrl = obj.baseUrl ?
      origin(obj.baseUrl)
      :
      proxyUrl

    _.extend(obj, {
      proxyUrl,
      browserUrl: rootUrl + obj.clientRoute,
      reporterUrl: rootUrl + obj.reporterRoute,
      xhrUrl: obj.namespace + obj.xhrRoute,
    })

    return obj
  },

  parseEnv (cfg, envCLI, resolved = {}) {
    const envVars = (resolved.env = {})

    const resolveFrom = (from, obj = {}) => {
      return _.each(obj, (val, key) => {
        return envVars[key] = {
          value: val,
          from,
        }
      })
    }

    const envCfg = cfg.env != null ? cfg.env : {}
    const envFile = cfg.envFile != null ? cfg.envFile : {}
    let envProc = this.getProcessEnvVars(process.env) || {}

    envCLI = envCLI != null ? envCLI : {}

    const matchesConfigKey = function (key) {
      if (_.has(CONFIG_DEFAULTS, key)) {
        return key
      }

      key = key.toLowerCase().replace(dashesOrUnderscoresRe, '')
      key = _.camelCase(key)

      if (_.has(CONFIG_DEFAULTS, key)) {
        return key
      }
    }

    const configFromEnv = _.reduce(envProc, (memo, val, key) => {
      let cfgKey

      cfgKey = matchesConfigKey(key)

      if (cfgKey) {
        // only change the value if it hasnt been
        // set by the CLI. override default + config
        if (resolved[cfgKey] !== 'cli') {
          cfg[cfgKey] = val
          resolved[cfgKey] = {
            value: val,
            from: 'env',
          }
        }

        memo.push(key)
      }

      return memo
    }
    , [])

    envProc = _.chain(envProc)
    .omit(configFromEnv)
    .mapValues(hideSpecialVals)
    .value()

    resolveFrom('config', envCfg)
    resolveFrom('envFile', envFile)
    resolveFrom('env', envProc)
    resolveFrom('cli', envCLI)

    // envCfg is from cypress.json
    // envFile is from cypress.env.json
    // envProc is from process env vars
    // envCLI is from CLI arguments
    return _.extend(envCfg, envFile, envProc, envCLI)
  },

  getProcessEnvVars (obj = {}) {
    return _.reduce(obj, (memo, value, key) => {
      if (isCypressEnvLike(key)) {
        memo[removeEnvPrefix(key)] = coerce(value)
      }

      return memo
    }
    , {})
  },

  getNameFromRoot (root = '') {
    return path.basename(root)
  },

}
