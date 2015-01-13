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

var db = new NeDB({ filename: 'instances.db', autoload: true });
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



var postDbRead = function(instance) {
  var prefix = '';

  if (instance._invoker_name) prefix = '/invokers/' + instance._invoker_name;
  else if (instance._executable_name) prefix = '/executables/' + instance._executable_name;

  instance._links = {
    self: { href: apiBase + prefix + '/instances/' + instance._id },
    parent: { href: apiBase + prefix + '/instances' }
  };

  return instance;
};

var preDbWrite = function(instance) {
  delete instance._links;

  return instance;
};

var invoke = function(instance, callback) {
  callback = callback || function(err) {
    if (err) console.error(err);
  };

  util.invokeExecutable({ apiSpec: apiSpec,
                          instance: instance,
                          executable_name: instance._executable_name,
                          invoker_name: instance._invoker_name }, function(err, r) {
    preDbWrite(instance);

    db.update({ _id: instance._id }, r, {}, callback);
  });
};



//TODO add routes:
//  /instances/<id>/parameters/<name>
//  /instances/<id>/results/<name>



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

// route: */instances
var getInstances = function(req, res, next) {
  var find = {};

  if (req.param('invoker')) find._invoker_name = req.param('invoker'); //{ $exists: true }
  else if (req.param('executable')) find._executable_name = req.param('executable'); //{ $exists: true }

  if (req.param('status')) find.status = req.param('status');

  db.find(find, function(err, instances) {
    if (err) return next(err);

    _.each(instances, function(instance) {
      postDbRead(instance);
    });

    res.jsonp(instances);
  });
};

var postInstances = function(req, res, next) {
  var instance = req.body;
  instance._id = uuid.v4();

  if (!instance.status) instance.status = 'running';

  if (!_.contains(validStatus, instance.status)) {
    var e = new Error('Invalid status = \'' + instance.status + '\'');
    e.status = 400;

    return next(e);
  } else if (instance._invoker_name && _.isEmpty(instance.executable)) {
    var e = new Error('Executable must be specified');
    e.status = 400;

    return next(e);
  }

  if (req.param('invoker')) {
    instance._invoker_name = req.param('invoker');

    delete instance._executable_name;
  } else if (req.param('executable')) {
    instance._executable_name = req.param('executable');

    delete instance._invoker_name;
  }

  instance.created = new Date().toString();

  delete instance.id;
  delete instance._links;

  db.findOne({ _id: instance._id }, function(err, existingInstance) {
    if (err) return next(err);

    if (existingInstance) {
      var e = new Error('Instance already exists with id = \'' + instance._id + '\'');
      e.status = 409;

      return next(e);
    }

    db.insert(instance, function(err, insertedInstance) {
      if (err) return next(err);

      instance = insertedInstance;

      postDbRead(instance);

      if (instance._executable_name) {
        res.set('Location', apiBase + '/executables/' + instance._executable_name + '/instances/' + instance._id);
      } else if (instance._invoker_name) {
        res.set('Location', apiBase + '/invokers/' + instance._invoker_name + '/instances/' + instance._id);
      }
      
      res.status(201).jsonp(instance);

      if (instance.status === 'running') invoke(instance);
    });
  });
};

// route: */instances/<id>
var getInstance = function(req, res, next) {
  var find = { _id: req.param('id') };

  db.findOne(find, function(err, instance) {
    if (err) return next(err);

    if (!instance) {
      var e = new Error('No instance found with id = \'' + req.param('id') + '\'');
      e.status = 404;

      return next(e);
    }

    postDbRead(instance);

    res.jsonp(instance);
  });
};

var putInstance = function(req, res, next) {
  var find = { _id: req.param('id') };

  if (!_.contains(validStatus, req.body.status)) {
    var e = new Error('Invalid status = \'' + instance.status + '\'');
    e.status = 400;

    return next(e);
  }

  db.findOne(find, function(err, instance) {
    if (err) return next(err);

    if (!instance) {
      var e = new Error('No instance found with id = \'' + req.param('id') + '\'');
      e.status = 404;

      return next(e);
    }

    if (instance.status !== 'prepare') {
      var e = new Error('Instance can only be updated if status = \'prepare\'');
      e.status = 400;

      return next(e);
    }

    _.each(req.body, function(val, key) {
      if (val === null) delete instance[key];
      else instance[key] = val;
    });

    db.update({ _id: instance._id }, instance, {}, function(err, numUpdated) {
      if (err) return next(err);

      postDbRead(instance);

      res.jsonp(instance);

      if (instance.status === 'running') invoke(instance);
    });
  });
};

var deleteInstance = function(req, res, next) {
  var find = { _id: req.param('id') };

  db.remove(find, {}, function(err, numRemoved) {
    if (err) return next(err);

    res.status(200).send();
  });
};



// register routes
app.get(apiBase + '/executables/:executable/instances', getInstances);
app.post(apiBase + '/executables/:executable/instances', postInstances);
app.get(apiBase + '/executables/:executable/instances/:id', getInstance);
app.put(apiBase + '/executables/:executable/instances/:id', putInstance);
app.delete(apiBase + '/executables/:executable/instances/:id', deleteInstance);

app.get(apiBase + '/invokers/:invoker/instances', getInstances);
app.post(apiBase + '/invokers/:invoker/instances', postInstances);
app.get(apiBase + '/invokers/:invoker/instances/:id', getInstance);
app.put(apiBase + '/invokers/:invoker/instances/:id', putInstance);
app.delete(apiBase + '/invokers/:invoker/instances/:id', deleteInstance);



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
