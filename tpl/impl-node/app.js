var express = require('express');
var favicon = require('serve-favicon');
var logger = require('morgan');
var cookieParser = require('cookie-parser');
var bodyParser = require('body-parser');

var exec = require('child_process').exec;
var path = require('path');
var fs = require('fs');
var uuid = require('uuid');
var _ = require('lodash');
var recursive = require('recursive-readdir');
var pkg = require('./package.json');
var debug = require('debug')(pkg.name);

var util = require('any2api-util');
var InstanceDB = require('any2api-instancedb-redis');

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

var dbConfig = {};

if (process.env.REDIS_HOST && process.env.REDIS_PORT) {
  dbConfig.redisConfig = {
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT
  };
}

var db = InstanceDB(dbConfig);



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



var postDbRead = function(instance, executableName, invokerName) {
  var prefix = '';

  if (executableName) prefix = '/executables/' + executableName;
  else if (invokerName) prefix = '/invokers/' + invokerName;

  instance._links = {
    self: { href: apiBase + prefix + '/instances/' + instance.id },
    parent: { href: apiBase + prefix + '/instances' }
  };

  if (!_.isEmpty(instance.parameters_list)) {
    instance._links.parameters = [];

    _.each(instance.parameters_list, function(name) {
      instance._links.parameters.push({
        href: apiBase + prefix + '/instances/' + instance.id + '/parameters/' + name
      });
    });
  }

  if (!_.isEmpty(instance.results_list)) {
    instance._links.results = [];

    _.each(instance.results_list, function(name) {
      instance._links.results.push({
        href: apiBase + prefix + '/instances/' + instance.id + '/results/' + name
      });
    });
  }

  return instance;
};

var preDbWrite = function(instance) {
  delete instance._id;
  delete instance._links;

  return instance;
};

var invoke = function(instance, executableName, invokerName, callback) {
  callback = callback || function(err) {
    if (err) console.error(err);
  };

  util.invokeExecutable({ apiSpec: apiSpec,
                          instance: instance,
                          executable_name: executableName,
                          invoker_name: invokerName }, function(err, instance) {
    preDbWrite(instance);

    db.instances.set({ instance: instance, executableName: executableName, invokerName: invokerName }, callback);
  });
};



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
  var args = {
    status: req.query.status,
    executableName: req.params.executable,
    invokerName: req.params.invoker
  };

  //if (req.param('invoker')) find._invoker_name = req.param('invoker'); //{ $exists: true }
  //else if (req.param('executable')) find._executable_name = req.param('executable'); //{ $exists: true }

  db.instances.getAll(args, function(err, instances) {
    if (err) return next(err);

    instances = _.toArray(instances);

    _.each(instances, function(instance) {
      postDbRead(instance, req.params.executable, req.params.invoker);
    });

    res.jsonp(instances);
  });
};

var postInstances = function(req, res, next) {
  var instance = req.body;
  instance.id = uuid.v4();

  if (!instance.status) instance.status = 'running';

  if (!_.contains(validStatus, instance.status)) {
    var e = new Error('Invalid status = \'' + instance.status + '\'');
    e.status = 400;

    return next(e);
  } else if (req.params.invoker && _.isEmpty(instance.executable)) {
    var e = new Error('Executable must be specified');
    e.status = 400;

    return next(e);
  }

  instance.created = new Date().toString();

  preDbWrite(instance);

  var args = {
    instance: instance,
    executableName: req.params.executable,
    invokerName: req.params.invoker
  };

  db.instances.get(args, function(err, existingInstance) {
    if (err) return next(err);

    if (existingInstance) {
      var e = new Error('Instance already exists with id = \'' + instance.id + '\'');
      e.status = 409;

      return next(e);
    }

    db.instances.set(args, function(err) {
      if (err) return next(err);

      postDbRead(instance, req.params.executable, req.params.invoker);

      if (req.params.executable) {
        res.set('Location', apiBase + '/executables/' + req.params.executable + '/instances/' + instance.id);
      } else if (req.params.invoker) {
        res.set('Location', apiBase + '/invokers/' + req.params.invoker + '/instances/' + instance.id);
      }
      
      res.status(201).jsonp(instance);

      if (instance.status === 'running') invoke(instance, req.params.executable, req.params.invoker);
    });
  });
};

// route: */instances/<id>
var getInstance = function(req, res, next) {
  var args = {
    id: req.params.id,
    executableName: req.params.executable,
    invokerName: req.params.invoker
  };

  if (req.query.embed_all_params) {
    args.embedParameters = 'all';
  } else if (req.query.embed_param) {
    args.embedParameters = req.query.embed_param;

    if (_.isString(args.embedParameters)) args.embedParameters = [ args.embedParameters ];
  }

  if (req.query.embed_all_results) {
    args.embedResults = 'all';
  } else if (req.query.embed_result) {
    args.embedResults = req.query.embed_result;

    if (_.isString(args.embedResults)) args.embedResults = [ args.embedResults ];
  }

  db.instances.get(args, function(err, instance) {
    if (err) return next(err);

    if (!instance) {
      var e = new Error('No instance found with id = \'' + req.params.id + '\'');
      e.status = 404;

      return next(e);
    }

    postDbRead(instance, req.params.executable, req.params.invoker);

    res.jsonp(instance);
  });
};

var putInstance = function(req, res, next) {
  var args = {
    id: req.params.id,
    executableName: req.params.executable,
    invokerName: req.params.invoker
  };

  if (!_.contains(validStatus, req.body.status)) {
    var e = new Error('Invalid status = \'' + instance.status + '\'');
    e.status = 400;

    return next(e);
  }

  db.instances.get(args, function(err, instance) {
    if (err) return next(err);

    if (!instance) {
      var e = new Error('No instance found with id = \'' + req.params.id + '\'');
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

    args.instance = instance;

    db.instances.set(args, function(err) {
      if (err) return next(err);

      postDbRead(instance, req.params.executable, req.params.invoker);

      res.jsonp(instance);

      if (instance.status === 'running') invoke(instance);
    });
  });
};

var deleteInstance = function(req, res, next) {
  var args = {
    id: req.params.id,
    executableName: req.params.executable,
    invokerName: req.params.invoker
  };

  db.instances.remove(args, function(err) {
    if (err) return next(err);

    res.status(200).send();
  });
};

// route: */instances/<id>/parameters/<name>
var getParameter = function(req, res, next) {
  var args = {
    id: req.params.id,
    name: req.params.name,
    executableName: req.params.executable,
    invokerName: req.params.invoker
  };

  db.parameters.get(args, function(err, value) {
    if (err) return next(err);

    if (!value) {
      var e = new Error('No value found for parameter \'' + req.params.name + '\'');
      e.status = 404;

      return next(e);
    }

    //TODO: set HTTP header Content-Type
    res.status(200).send(value);
  });
};

var putParameter = function(req, res, next) {
  next();
  //TODO: implement
};

var deleteParameter = function(req, res, next) {
  var args = {
    id: req.params.id,
    name: req.params.name,
    executableName: req.params.executable,
    invokerName: req.params.invoker
  };

  db.parameters.remove(args, function(err) {
    if (err) return next(err);

    res.status(200).send();
  });
};

// route: */instances/<id>/results/<name>
var getResult = function(req, res, next) {
  var args = {
    id: req.params.id,
    name: req.params.name,
    executableName: req.params.executable,
    invokerName: req.params.invoker
  };

  db.results.get(args, function(err, value) {
    if (err) return next(err);

    if (!value) {
      var e = new Error('No value found for result \'' + req.params.name + '\'');
      e.status = 404;

      return next(e);
    }

    //TODO: set HTTP header Content-Type
    res.status(200).send(value);
  });
};

var putResult = function(req, res, next) {
  next();
  //TODO: implement
};

var deleteResult = function(req, res, next) {
  var args = {
    id: req.params.id,
    name: req.params.name,
    executableName: req.params.executable,
    invokerName: req.params.invoker
  };

  db.results.remove(args, function(err) {
    if (err) return next(err);

    res.status(200).send();
  });
};



// register routes
_.each([ 'executable', 'invoker' ], function(str) {
  app.get(apiBase + '/' + str + 's/:' + str + '/instances', getInstances);
  app.post(apiBase + '/' + str + 's/:' + str + '/instances', postInstances);
  app.get(apiBase + '/' + str + 's/:' + str + '/instances/:id', getInstance);
  app.put(apiBase + '/' + str + 's/:' + str + '/instances/:id', putInstance);
  app.delete(apiBase + '/' + str + 's/:' + str + '/instances/:id', deleteInstance);

  app.get(apiBase + '/' + str + 's/:' + str + '/instances/:id/parameters/:name', getParameter);
  app.put(apiBase + '/' + str + 's/:' + str + '/instances/:id/parameters/:name', putParameter);
  app.delete(apiBase + '/' + str + 's/:' + str + '/instances/:id/parameters/:name', deleteParameter);

  app.get(apiBase + '/' + str + 's/:' + str + '/instances/:id/results/:name', getResult);
  app.put(apiBase + '/' + str + 's/:' + str + '/instances/:id/results/:name', putResult);
  app.delete(apiBase + '/' + str + 's/:' + str + '/instances/:id/results/:name', deleteResult);
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
