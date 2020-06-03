/* eslint-disable
  import/order
*/
const fs = require('fs');
const os = require('os');
const path = require('path');
const async = require('neo-async');
const crypto = require('crypto');
const mkdirp = require('mkdirp');
const findCacheDir = require('find-cache-dir');
const BJSON = require('buffer-json');

const { getOptions } = require('loader-utils');
const validateOptions = require('schema-utils');

const pkg = require('../package.json');

const env = process.env.NODE_ENV || 'development';

const schema = require('./options.json');

const defaults = {
  cacheContext: '',
  cacheDirectory: findCacheDir({ name: 'cache-loader' }) || os.tmpdir(),
  cacheIdentifier: `cache-loader:${pkg.version} ${env}`,
  cacheKey,
  compareMode: 'mtime',
  precision: 0,
  read,
  readOnly: false,
  write,
};

function pathWithCacheContext(cacheContext, originalPath) {
  if (!cacheContext) {
    return originalPath;
  }

  if (originalPath.includes(cacheContext)) {
    return originalPath
      .split('!')
      .map((subPath) => path.relative(cacheContext, subPath))
      .join('!');
  }

  return originalPath
    .split('!')
    .map((subPath) => path.resolve(cacheContext, subPath))
    .join('!');
}

function roundMs(mtime, precision) {
  return Math.floor(mtime / precision) * precision;
}

// NOTE: We should only apply `pathWithCacheContext` transformations
// right before writing. Every other internal steps with the paths
// should be accomplish over absolute paths. Otherwise we have the risk
// to break watchpack -> chokidar watch logic  over webpack@4 --watch
function loader(...args) {
  const options = Object.assign({}, defaults, getOptions(this));

  validateOptions(schema, options, {
    name: 'Cache Loader',
    baseDataPath: 'options',
  });

  const { readOnly, write: writeFn } = options;

  // In case we are under a readOnly mode on cache-loader
  // we don't want to write or update any cache file
  if (readOnly) {
    this.callback(null, ...args);
    return;
  }

  const callback = this.async();
  const { data } = this;
  const dependencies = this.getDependencies().concat(
    this.loaders.map((l) => l.path)
  );
  const contextDependencies = this.getContextDependencies();

  // Should the file get cached?
  const cache = true;
  // this.fs can be undefined
  // e.g when using the thread-loader
  // fallback to the fs module
  const FS = this.fs || fs;
  const toDepDetails = (dep, mapCallback) => {
    computeDepDetails(FS, options, dep, (detailsErr, details) => {
      if (detailsErr) {
        mapCallback(detailsErr);
        return;
      }

      mapCallback(null, {
        path: pathWithCacheContext(options.cacheContext, dep),
        ...details,
      });
    });
  };

  async.parallel(
    [
      (cb) => async.mapLimit(dependencies, 20, toDepDetails, cb),
      (cb) => async.mapLimit(contextDependencies, 20, toDepDetails, cb),
    ],
    (err, taskResults) => {
      if (err) {
        callback(null, ...args);
        return;
      }
      if (!cache) {
        callback(null, ...args);
        return;
      }
      const [deps, contextDeps] = taskResults;
      writeFn(
        data.cacheKey,
        {
          remainingRequest: pathWithCacheContext(
            options.cacheContext,
            data.remainingRequest
          ),
          dependencies: deps,
          contextDependencies: contextDeps,
          result: args,
        },
        () => {
          // ignore errors here
          callback(null, ...args);
        }
      );
    }
  );
}

// NOTE: We should apply `pathWithCacheContext` transformations
// right after reading. Every other internal steps with the paths
// should be accomplish over absolute paths. Otherwise we have the risk
// to break watchpack -> chokidar watch logic  over webpack@4 --watch
function pitch(remainingRequest, prevRequest, dataInput) {
  const options = Object.assign({}, defaults, getOptions(this));

  validateOptions(schema, options, {
    name: 'Cache Loader (Pitch)',
    baseDataPath: 'options',
  });

  const {
    cacheContext,
    cacheKey: cacheKeyFn,
    compareMode,
    read: readFn,
  } = options;

  const callback = this.async();
  const data = dataInput;

  data.remainingRequest = remainingRequest;
  data.cacheKey = cacheKeyFn(options, data.remainingRequest);
  readFn(data.cacheKey, (readErr, cacheData) => {
    if (readErr) {
      callback();
      return;
    }

    // We need to patch every path within data on cache with the cacheContext,
    // or it would cause problems when watching
    if (
      pathWithCacheContext(options.cacheContext, cacheData.remainingRequest) !==
      data.remainingRequest
    ) {
      // in case of a hash conflict
      callback();
      return;
    }
    const FS = this.fs || fs;
    async.each(
      cacheData.dependencies.concat(cacheData.contextDependencies),
      (dep, eachCallback) => {
        // Applying reverse path transformation, in case they are relatives, when
        // reading from cache
        const contextDep = {
          ...dep,
          path: pathWithCacheContext(options.cacheContext, dep.path),
        };

        computeDepDetails(
          FS,
          options,
          contextDep.path,
          (detailsErr, details) => {
            if (detailsErr) {
              eachCallback(detailsErr);
              return;
            }

            if (!details) {
              eachCallback();
              return;
            }

            if (
              compareMode in contextDep &&
              contextDep[compareMode] === details[compareMode]
            ) {
              // Read from cache
              eachCallback();
            } else {
              // Do not read from cache
              eachCallback(true);
            }
          }
        );
      },
      (err) => {
        if (err) {
          data.startTime = Date.now();
          callback();
          return;
        }
        cacheData.dependencies.forEach((dep) =>
          this.addDependency(pathWithCacheContext(cacheContext, dep.path))
        );
        cacheData.contextDependencies.forEach((dep) =>
          this.addContextDependency(
            pathWithCacheContext(cacheContext, dep.path)
          )
        );
        callback(null, ...cacheData.result);
      }
    );
  });
}

function computeDepDetails(FS, options, depPath, callback) {
  const { compareMode, readOnly, precision } = options;

  switch (compareMode) {
    case 'mtime': {
      FS.stat(depPath, (statErr, stats) => {
        if (statErr) {
          callback(statErr);
          return;
        }

        // When we are under a readOnly config on cache-loader
        // we don't want to emit any other error than a
        // file stat error
        if (readOnly) {
          callback();
          return;
        }

        let mtime = stats.mtimeMs;
        if (precision > 1) {
          mtime = roundMs(mtime, precision);
        }

        callback(null, { mtime });
      });
      break;
    }
    case 'hash': {
      FS.readFile(depPath, (err, data) => {
        if (err) {
          callback(err);
          return;
        }
        const hash = crypto.createHash('md5');
        hash.update(data);
        callback(null, { hash: hash.digest('hex') });
      });
      break;
    }
    default:
      throw new Error(`unsupported compareMode "${compareMode}".`);
  }
}

function digest(str) {
  return crypto
    .createHash('md5')
    .update(str)
    .digest('hex');
}

const directories = new Set();

function write(key, data, callback) {
  const dirname = path.dirname(key);
  const content = BJSON.stringify(data);

  if (directories.has(dirname)) {
    // for performance skip creating directory
    fs.writeFile(key, content, 'utf-8', callback);
  } else {
    mkdirp(dirname, (mkdirErr) => {
      if (mkdirErr) {
        callback(mkdirErr);
        return;
      }

      directories.add(dirname);

      fs.writeFile(key, content, 'utf-8', callback);
    });
  }
}

function read(key, callback) {
  fs.readFile(key, 'utf-8', (err, content) => {
    if (err) {
      callback(err);
      return;
    }

    try {
      const data = BJSON.parse(content);
      callback(null, data);
    } catch (e) {
      callback(e);
    }
  });
}

function cacheKey(options, request) {
  const { cacheIdentifier, cacheDirectory } = options;
  const hash = digest(`${cacheIdentifier}\n${request}`);

  return path.join(cacheDirectory, `${hash}.json`);
}

export const raw = true;
export { loader as default, pitch };
