var express = require('express');
var favicon = require('serve-favicon');
var logger = require('morgan');
var cookieParser = require('cookie-parser');
var bodyParser = require('body-parser');

var NeDB = require('nedb');

var exec = require('child_process').exec;
var path = require('path');
var fs = require('fs');
var uuid = require('uuid');
var _ = require('lodash');

var readInput = require('any2api-util').readInput;

var apiSpecPath = './apispec.json';

var validStatus = [ 'prepare', 'running', 'finished', 'error' ];

var nodeBinDir = path.resolve(process.execPath, '..'); // '/usr/local/opt/nvm/v0.10.33/bin'
if (nodeBinDir) process.env.PATH = nodeBinDir + path.delimiter + process.env.PATH;



var app = express();

//app.use(favicon(__dirname + '/static/favicon.ico'));
app.use(logger('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'static')));

var apiBase = '/api/v1';

var db = new NeDB({ filename: 'runs.db', autoload: true });
db.persistence.setAutocompactionInterval(5000);



var attachLinksSync = function(run) {
  run._links = {
    self: { href: apiBase + '/runs/' + run._id },
    parent: { href: apiBase + '/runs' }
  };

  return run;
};

var invoke = function(run, callback) {
  var update = function(updatedRun, callback) {
    updatedRun._id = run._id;

    db.update({ _id: run._id }, updatedRun, {}, function(err, numUpdated) {
      if (err) console.error(err);

      if (callback) callback(err);
    });
  };

  var handleErr = function(err, run, callback) {
    if (err) {
      run.status = 'error';

      run.failed = new Date().toString();

      run.error = err;

      update(run, callback);
    }
  };

  readInput({ apispec_path: apiSpecPath }, function(err, spec) {
    if (err) return handleErr(err, run, callback);

    if (_.isEmpty(run.parameters)) run.parameters = {};

    var options = {
      cwd: spec.invoker_path,
      env: {
        APISPEC: JSON.stringify(spec),
        PARAMETERS: JSON.stringify(run.parameters),
        PATH: process.env.PATH
      }
    };

    if (spec.implementation_port) options.env.PORT = spec.implementation_port;

    exec('npm start', options, function(err, stdout, stderr) {
      run.results = run.results || {};

      run.results.stdout = stdout;
      run.results.stderr = stderr;

      if (err) return handleErr(err, run, callback);

      run.status = 'finished';
      run.finished = new Date().toString();

      var invokerConfig = JSON.parse(fs.readFileSync(path.join(spec.invoker_path, 'invoker.json')));
      var results = invokerConfig.results || {};

      _.merge(results, spec.results);

      _.each(results, function(r, name) {
        if (r.mapping === 'stdout') {
          run.results[name] = stdout;

          delete run.results.stdout;
        } else if (r.mapping === 'stderr') {
          run.results[name] = stderr;

          delete run.results.stderr;
        } else if (r.mapping === 'file' && r.file_path) {
          run.results[name] = fs.readFileSync(path.join(spec.invoker_path, r.file_path), { encoding: 'utf8' });
        }

        if (r.type === 'object') {
          run.results[name] = JSON.parse(run.results[name]);
        }
      });

      update(run, callback);
    });
  });
};



//TODO add routes:
//  /runs/<id>/parameters/<name>
//  /runs/<id>/results/<name>



// root route
app.get('/', function(req, res, next) {
  res.redirect('spec.html');
});

// route: /runs
app.get(apiBase + '/runs', function(req, res) {
  var find = {};

  if (req.param('status')) find = { status: req.param('status') };

  db.find(find, function(err, runs) {
    if (err) return next(err);

    _.each(runs, function(run) {
      attachLinksSync(run);
    });

    res.jsonp(runs);
  });
});

app.post(apiBase + '/runs', function(req, res, next) {
  var run = req.body;

  if (!run.status) run.status = 'running';

  if (!_.contains(validStatus, run.status)) {
    var e = new Error('Invalid status = \'' + run.status + '\'');
    e.status = 400;

    return next(e);
  }

  if (run.id) run._id = run.id;
  if (!run._id) run._id = uuid.v4();

  if (!run.status) run.status = 'running';
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

      attachLinksSync(run);

      res.set('Location', apiBase + '/runs/' + run._id);
      res.status(201).jsonp(run);

      if (run.status === 'running') invoke(run);
    });
  });
});

// route: /runs/<id>
app.get(apiBase + '/runs/:id', function(req, res, next) {
  db.findOne({ _id: req.param('id') }, function(err, run) {
    if (err) return next(err);

    if (!run) {
      var e = new Error('No run found with id = \'' + req.param('id') + '\'');
      e.status = 404;

      return next(e);
    }

    attachLinksSync(run);

    res.jsonp(run);
  });
});

app.put(apiBase + '/runs/:id', function(req, res, next) {
  if (!_.contains(validStatus, req.body.status)) {
    var e = new Error('Invalid status = \'' + run.status + '\'');
    e.status = 400;

    return next(e);
  }

  db.findOne({ _id: req.param('id') }, function(err, run) {
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

    db.update({ _id: run._id }, run, function(err, numUpdated) {
      if (err) return next(err);

      attachLinksSync(run);

      res.jsonp(run);

      if (run.status === 'running') invoke(run);
    });
  });
});

app.delete(apiBase + '/runs/:id', function(req, res, next) {
  db.remove({ _id: req.param('id') }, {}, function(err, numRemoved) {
    if (err) return next(err);

    res.status(200).send();
  });
});



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
