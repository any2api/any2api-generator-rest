var express = require('express');
var favicon = require('serve-favicon');
var logger = require('morgan');
var cookieParser = require('cookie-parser');
var bodyParser = require('body-parser');

var NeDB = require('nedb');

var exec = require('child_process').exec;
var path = require('path');
var fs = require('fs-extra');
var uuid = require('uuid');
var async = require('async');
var request = require('request');
var _ = require('lodash');
var recursive = require('recursive-readdir');
var temp = require('temp').track();
var pkg = require('./package.json');
var debug = require('debug')(pkg.name);

var util = require('any2api-util');

var validStatus = [ 'prepare', 'running', 'finished', 'error' ];

var nodeBinDir = path.resolve(process.execPath, '..'); // '/usr/local/opt/nvm/v0.10.33/bin'
if (nodeBinDir) process.env.PATH = nodeBinDir + path.delimiter + process.env.PATH;



var app = express();

app.set('json spaces', 2);
//app.use(favicon(__dirname + '/static/favicon.ico'));
app.use(logger('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'static')));



var apiBase = '/api/v1';

var preparedInvokers = {};

var db = new NeDB({ filename: 'runs.db', autoload: true });
db.persistence.setAutocompactionInterval(5000);

// Generate index
var staticPath = path.join(__dirname, 'static');
var executablesPath = path.resolve(staticPath, 'executables');

var index = {
  _links: { self: { href: '/' } }
};

if (fs.existsSync(executablesPath)) {
  recursive(executablesPath, function(err, files) {
    if (err) console.error(err);

    _.each(files, function(file) {
      index._links[path.relative(staticPath, file)] =
        { href: '/' + path.relative(staticPath, file).replace(/\\/g,'/') };
    });
  });
}

// Read API spec
var apiSpec = { executables: {}, invokers: {} };

util.readInput({ specPath: path.join(__dirname, 'apispec.json') }, function(err, as) {
  if (err) throw err;

  apiSpec = as;

  index.spec = { href: '/api/v1/spec' };
  index.docs = { href: '/api/v1/docs' };
  index.console = { href: '/console' };
});



var postDbRead = function(run) {
  var prefix = '';

  if (run._invoker_name) prefix = '/invokers/' + run._invoker_name;
  else if (run._executable_name) prefix = '/executables/' + run._executable_name;

  run._links = {
    self: { href: apiBase + prefix + '/runs/' + run._id },
    parent: { href: apiBase + prefix + '/runs' }
  };

  return run;
};

var preDbWrite = function(run) {
  delete run._links;

  return run;
};

var invoke = function(run, callback) {
  debug('invocation triggered', run);

  // API spec copy
  var apiSpecCopy = util.cloneSpecSync(apiSpec); //TODO: make this async and write cloned spec in util/index.js!

  // Executable and invoker path
  var executable = null;
  var invokerPath = null;

  if (run._executable_name) {
    executable = apiSpecCopy.executables[run._executable_name];

    invokerPath = apiSpecCopy.invokers[executable.invoker_name].path;
  } else if (run._invoker_name) {
    invokerPath = apiSpecCopy.invokers[run._invoker_name].path;

    if (run.executable) {
      executable = run.executable;

      executable.name = executable.name || 'embedded-' + uuid.v4();

      executable.invoker_name = run._invoker_name;

      apiSpecCopy.executables[executable.name] = executable;
    }
  }

  if (executable) executable.name = run._executable_name || executable.name;

  // Persist embedded executable
  var persistEmbeddedExecutable = function(callback) {
    if (!executable || !executable.files) return callback();

    //TODO: support executable.tarball_url

    debug('persisting executable', executable);

    temp.mkdir('tmp-executable-' + executable.name, function(err, execPath) {
      executable.path = execPath;

      async.eachSeries(executable.files, function(file, callback) {
        if (!file.path) return callback();

        fs.mkdirs(path.join(execPath, path.dirname(file.path)), function(err) {
          if (err) return callback(err);

          debug('persisting file', file);

          if (file.text) {
            fs.writeFile(path.join(execPath, file.path), file.text, 'utf8', callback);
          } else if (file.object) {
            fs.writeFile(path.join(execPath, file.path), JSON.stringify(file.object), 'utf8', callback);
          } else if (file.base64) {
            fs.writeFile(path.join(execPath, file.path), file.base64, 'base64', callback);
          } else if (file.url) {
            request(file.url).pipe(fs.createWriteStream(path.join(execPath, file.path)))
              .on('finish', callback)
              .on('error', callback);
          } else {
            callback();
          }
        });
      }, callback);
    });
  };
  
  // Read invoker.json
  var invokerJson = JSON.parse(fs.readFileSync(path.join(invokerPath, 'invoker.json')));

  // Process parameters
  var paramsRequired = invokerJson.parameters_required || [];
  var paramsSchema = invokerJson.parameters_schema;

  if (_.isEmpty(run.parameters)) run.parameters = {};

  var runParams = { run_id: run._id, run_path: temp.path({ prefix: 'tmp-run-' }) };
  var enrichedParams = _.clone(run.parameters);
  enrichedParams._ = runParams;

  if (executable) {
    runParams.executable_name = executable.name;
    paramsRequired = _.uniq(paramsRequired.concat(executable.parameters_required || []));
    paramsSchema = _.extend(paramsSchema, executable.parameters_schema)
  }

  _.each(paramsSchema, function(p, name) {
    if (_.contains(paramsRequired, name) && !enrichedParams[name] && p.default) {
      enrichedParams[name] = p.default;
    }
  });

  debug('enriched params', enrichedParams);

  async.series([
    async.apply(persistEmbeddedExecutable),
    function(callback) {
      if (executable && !executable.prepared) {
        debug('preparing buildtime');

        util.prepareBuildtime({ apiSpec: apiSpecCopy,
                                preparedInvokers: preparedInvokers,
                                executable_name: run._executable_name || executable.name },
                              callback);
      } else {
        callback();
      }
    },
    function(callback) {
      if (executable && !executable.prepared) {
        debug('preparing executable');

        var updateSpecCallback = function(err, updApiSpec) {
          if (err) return callback(err);

          if (updApiSpec) apiSpecCopy = updApiSpec;

          callback();
        };

        util.prepareExecutable({ apiSpec: apiSpecCopy,
                                 executable_name: run._executable_name || executable.name },
                               updateSpecCallback);
      } else {
        callback();
      }
    },
    function(callback) {
      debug('running executable');

      var options = {
        cwd: invokerPath,
        env: {
          APISPEC: JSON.stringify(apiSpecCopy),
          PARAMETERS: JSON.stringify(enrichedParams),
          PATH: process.env.PATH
        }
      };

      exec('npm start', options, function(err, stdout, stderr) {
        debug('run complete');

        run.results = run.results || {};

        run.results.stdout = stdout;
        run.results.stderr = stderr;

        callback(err);
      });
    },
    function(callback) {
      var results_schema = invokerJson.results_schema || {};

      if (executable) _.extend(results_schema, executable.results_schema);

      var filesDir = runParams.run_path || invokerPath;

      async.eachSeries(_.keys(results_schema), function(name, callback) {
        var r = results_schema[name];

        if (r.mapping === 'stdout') {
          run.results[name] = run.results.stdout;

          delete run.results.stdout;
        } else if (r.mapping === 'stderr') {
          run.results[name] = run.results.stderr;

          delete run.results.stderr;
        } else if (r.mapping === 'file' && r.file_path) {
          var filePath = path.resolve(filesDir, r.file_path);

          if (!fs.existsSync(filePath)) {
            return callback(new Error('results file missing: ' + filePath));
          }

          run.results[name] = fs.readFileSync(filePath, 'utf8');
        }

        if (r.type === 'object') {
          run.results[name] = JSON.parse(run.results[name]);
        }

        callback();
      }, callback);
    }
  ], function(err) {
    if (err) {
      console.error(err);

      run.status = 'error';
      run.failed = new Date().toString();

      run.error = err.message;
    } else {
      run.status = 'finished';
      run.finished = new Date().toString();
    }

    preDbWrite(run);

    async.parallel([
      async.apply(fs.remove, runParams.run_path),
      async.apply(fs.remove, apiSpecCopy.apispec_path),
      function(callback) {
        db.update({ _id: run._id }, run, {}, callback);
      }
    ], function(err2) {
      if (err2) console.error(err2);

      if (callback) callback(err);
    });
  });
};



//TODO add routes:
//  /runs/<id>/parameters/<name>
//  /runs/<id>/results/<name>



// docs and spec routes
app.get('/', function(req, res, next) {
  res.set('Content-Type', 'application/json').jsonp(index);
});

app.get(apiBase, function(req, res, next) {
  res.redirect(apiBase + '/docs');
});

app.get(apiBase + '/docs', function(req, res, next) {
  fs.readFile(path.resolve(__dirname, 'docs.html'), 'utf8', function(err, content) {
    if (err) return next(err);

    content = content.replace(/{host}/g, req.get('Host'));

    res.set('Content-Type', 'text/html').send(content);
  });
});

app.get(apiBase + '/spec', function(req, res, next) {
  fs.readFile(path.resolve(__dirname, 'spec.raml'), 'utf8', function(err, content) {
    if (err) return next(err);

    content = content.replace(/{host}/g, req.get('Host'));

    res.set('Content-Type', 'application/raml+yaml').send(content);
  });
});

// route: */runs
var getRuns = function(req, res, next) {
  var find = {};

  if (req.param('invoker')) find._invoker_name = req.param('invoker'); //{ $exists: true }
  else if (req.param('executable')) find._executable_name = req.param('executable'); //{ $exists: true }

  if (req.param('status')) find.status = req.param('status');

  db.find(find, function(err, runs) {
    if (err) return next(err);

    _.each(runs, function(run) {
      postDbRead(run);
    });

    res.jsonp(runs);
  });
};

var postRuns = function(req, res, next) {
  var run = req.body;
  run._id = uuid.v4();

  if (!run.status) run.status = 'running';

  if (!_.contains(validStatus, run.status)) {
    var e = new Error('Invalid status = \'' + run.status + '\'');
    e.status = 400;

    return next(e);
  } else if (run._invoker_name && _.isEmpty(run.executable)) {
    var e = new Error('Executable must be specified');
    e.status = 400;

    return next(e);
  }

  if (req.param('invoker')) {
    run._invoker_name = req.param('invoker');

    delete run._executable_name;
  } else if (req.param('executable')) {
    run._executable_name = req.param('executable');

    delete run._invoker_name;
  }

  run.created = new Date().toString();

  delete run.id;
  delete run._links;

  db.findOne({ _id: run._id }, function(err, existingRun) {
    if (err) return next(err);

    if (existingRun) {
      var e = new Error('Run already exists with id = \'' + run._id + '\'');
      e.status = 409;

      return next(e);
    }

    db.insert(run, function(err, insertedRun) {
      if (err) return next(err);

      run = insertedRun;

      postDbRead(run);

      if (run._executable_name) {
        res.set('Location', apiBase + '/executables/' + run._executable_name + '/runs/' + run._id);
      } else if (run._invoker_name) {
        res.set('Location', apiBase + '/invokers/' + run._invoker_name + '/runs/' + run._id);
      }
      
      res.status(201).jsonp(run);

      if (run.status === 'running') invoke(run);
    });
  });
};

// route: */runs/<id>
var getRun = function(req, res, next) {
  var find = { _id: req.param('id') };

  db.findOne(find, function(err, run) {
    if (err) return next(err);

    if (!run) {
      var e = new Error('No run found with id = \'' + req.param('id') + '\'');
      e.status = 404;

      return next(e);
    }

    postDbRead(run);

    res.jsonp(run);
  });
};

var putRun = function(req, res, next) {
  var find = { _id: req.param('id') };

  if (!_.contains(validStatus, req.body.status)) {
    var e = new Error('Invalid status = \'' + run.status + '\'');
    e.status = 400;

    return next(e);
  }

  db.findOne(find, function(err, run) {
    if (err) return next(err);

    if (!run) {
      var e = new Error('No run found with id = \'' + req.param('id') + '\'');
      e.status = 404;

      return next(e);
    }

    if (run.status !== 'prepare') {
      var e = new Error('Run can only be updated if status = \'prepare\'');
      e.status = 400;

      return next(e);
    }

    _.each(req.body, function(val, key) {
      if (val === null) delete run[key];
      else run[key] = val;
    });

    db.update({ _id: run._id }, run, {}, function(err, numUpdated) {
      if (err) return next(err);

      postDbRead(run);

      res.jsonp(run);

      if (run.status === 'running') invoke(run);
    });
  });
};

var deleteRun = function(req, res, next) {
  var find = { _id: req.param('id') };

  db.remove(find, {}, function(err, numRemoved) {
    if (err) return next(err);

    res.status(200).send();
  });
};



// register routes
app.get(apiBase + '/executables/:executable/runs', getRuns);
app.post(apiBase + '/executables/:executable/runs', postRuns);
app.get(apiBase + '/executables/:executable/runs/:id', getRun);
app.put(apiBase + '/executables/:executable/runs/:id', putRun);
app.delete(apiBase + '/executables/:executable/runs/:id', deleteRun);

app.get(apiBase + '/invokers/:invoker/runs', getRuns);
app.post(apiBase + '/invokers/:invoker/runs', postRuns);
app.get(apiBase + '/invokers/:invoker/runs/:id', getRun);
app.put(apiBase + '/invokers/:invoker/runs/:id', putRun);
app.delete(apiBase + '/invokers/:invoker/runs/:id', deleteRun);



// catch 404 and forward to error handler
app.use(function(req, res, next) {
  var err = new Error('Not Found');
  err.status = 404;

  next(err);
});

// development error handler: print stacktrace
if (app.get('env') === 'development') {
  app.use(function(err, req, res, next) {
    res.status(err.status || 500);

    res.jsonp({
        message: err.message,
        error: err
    });
  });
}

// production error handler: no stacktraces leaked to user
app.use(function(err, req, res, next) {
  res.status(err.status || 500);

  res.jsonp({
    message: err.message,
    error: {}
  });
});



module.exports = app;
