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

  index._links.spec = { href: '/api/v1/spec' };
  index._links.docs = { href: '/api/v1/docs' };
  index._links.console = { href: '/console' };
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
  callback = callback || function(err) {
    if (err) console.error(err);
  };

  util.invokeExecutable({ apiSpec: apiSpec,
                          run: run,
                          executable_name: run._executable_name,
                          invoker_name: run._invoker_name }, function(err, r) {
    preDbWrite(run);

    db.update({ _id: run._id }, r, {}, callback);
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
