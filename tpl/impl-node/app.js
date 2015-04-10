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
var mmm = require('mmmagic');
var magicMime = new mmm.Magic(mmm.MAGIC_MIME);

var util = require('any2api-util');
var InstanceDB = require('any2api-instancedb-redis');

var validStatus = [ 'prepare', 'running', 'finished', 'error' ];
var requestLimit = '10mb';



var app = express();

app.set('json spaces', 2);
//app.use(favicon(__dirname + '/static/favicon.ico'));
app.use(logger('dev'));
app.use(bodyParser.json({ limit: requestLimit }));
//app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.text({ limit: requestLimit }));
app.use(bodyParser.raw({ limit: requestLimit }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'static')));

var apiBase = '/api/v1';

var apiSpec;

var db;

var dbConfig = {};

if (process.env.REDIS_HOST && process.env.REDIS_PORT) {
  dbConfig.redisConfig = {
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT
  };
}



// Generate index
var staticPath = path.join(__dirname, 'static');
var executablesPath = path.resolve(staticPath, 'executables');

var index = {
  _links: {
    self: { href: '/' }
  }
};

var indexFiles = [];

if (fs.existsSync(executablesPath)) {
  recursive(executablesPath, function(err, files) {
    if (err) console.error(err);

    _.each(files, function(file) {
      indexFiles.push({ href: '/' + path.relative(staticPath, file).replace(/\\/g,'/') });
    });
  });
}



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
      addLinks(instance, req.params.executable, req.params.invoker);
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

  removeLinks(instance);

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

      // trigger invocation
      if (instance.status === 'running') invoke(instance, req.params.executable, req.params.invoker);

      // send response
      if (req.params.executable) {
        res.set('Location', apiBase + '/executables/' + req.params.executable + '/instances/' + instance.id);
      } else if (req.params.invoker) {
        res.set('Location', apiBase + '/invokers/' + req.params.invoker + '/instances/' + instance.id);
      }

      addLinks(instance, req.params.executable, req.params.invoker);
      
      res.status(201).jsonp(instance);
    });
  });
};

// route: */instances/<id>
var getInstance = function(req, res, next) {
  var args = {
    id: req.params.id,
    executableName: req.params.executable,
    invokerName: req.params.invoker,
    preferBase64: true
  };

  if (req.query.embed_all_parameters || req.query.embed_all_params) {
    args.embedParameters = 'all';
  } else if (req.query.embed_parameter || req.query.embed_param) {
    args.embedParameters = req.query.embed_parameter || req.query.embed_param;

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

    addLinks(instance, req.params.executable, req.params.invoker);

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

      addLinks(instance, req.params.executable, req.params.invoker);

      res.jsonp(instance);

      if (instance.status === 'running') invoke(req.params.id, req.params.executable, req.params.invoker);
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
  req.params.name = req.params[0];

  var args = {
    id: req.params.id,
    parameterName: req.params.name,
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

    var schema;

    if (apiSpec.executables[req.params.executable]) {
      schema = apiSpec.executables[req.params.executable].parameters_schema;
    } else if (apiSpec.invokers[req.params.invoker]) {
      schema = apiSpec.invokers[req.params.invoker].parameters_schema;
    }

    determineContentType(req, res, schema, value, function(err) {
      if (err) return next(err);

      res.status(200).send(value);
    });
  });
};

var putParameter = function(req, res, next) {
  req.params.name = req.params[0];

  var args = {
    id: req.params.id,
    parameterName: req.params.name,
    executableName: req.params.executable,
    invokerName: req.params.invoker
  };

  // request content-type = application/octet-stream --> Buffer
  // request content-type = text/plain --> string
  if (req.body) {
    args.value = req.body;

    db.parameters.set(args, function(err) {
      if (err) return next(err);

      res.status(200).send();
    });
  } else {
    var e = new Error('Body must not be empty');
    e.status = 400;

    next(e);
  }
};

var deleteParameter = function(req, res, next) {
  req.params.name = req.params[0];

  var args = {
    id: req.params.id,
    parameterName: req.params.name,
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
  req.params.name = req.params[0];

  var args = {
    id: req.params.id,
    resultName: req.params.name,
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

    var schema;

    if (apiSpec.executables[req.params.executable]) {
      schema = apiSpec.executables[req.params.executable].results_schema;
    } else if (apiSpec.invokers[req.params.invoker]) {
      schema = apiSpec.invokers[req.params.invoker].results_schema;
    }

    determineContentType(req, res, schema, value, function(err) {
      if (err) return next(err);

      res.status(200).send(value);
    });
  });
};



// Helper functions
var addLinks = function(instance, executableName, invokerName) {
  var prefix = '';

  if (executableName) prefix = '/executables/' + executableName;
  else if (invokerName) prefix = '/invokers/' + invokerName;

  instance._links = {
    self: { href: apiBase + prefix + '/instances/' + instance.id },
    parent: { href: apiBase + prefix + '/instances' }
  };

  if (!_.isEmpty(instance.parameters_stored)) {
    instance._links.parameters = [];

    _.each(instance.parameters_stored, function(name) {
      instance._links.parameters.push({
        href: apiBase + prefix + '/instances/' + instance.id + '/parameters/' + name
      });
    });
  }

  if (!_.isEmpty(instance.results_stored)) {
    instance._links.results = [];

    _.each(instance.results_stored, function(name) {
      instance._links.results.push({
        href: apiBase + prefix + '/instances/' + instance.id + '/results/' + name
      });
    });
  }

  return instance;
};

var removeLinks = function(instance) {
  delete instance._links;

  return instance;
};

var invoke = function(instance, executableName, invokerName, callback) {
  callback = callback || function(err) {
    if (err) console.error(err);
  };

  var invokeArgs = {
    apiSpec: apiSpec,
    instance: instance,
    executable_name: executableName,
    invoker_name: invokerName
  };

  var dbArgs = {
    executableName: executableName,
    invokerName: invokerName,
    embedParameters: 'all'
  };

  if (_.isString(instance)) {
    dbArgs.id = instance;

    db.instances.get(dbArgs, function(err, instance) {
      if (err) return callback(err);

      if (!instance) {
        return callback(new Error('No instance found with id = \'' + dbArgs.id + '\''));
      }

      invokeArgs.instance = instance;
      dbArgs.instance = instance;

      util.invokeExecutable(invokeArgs, function(err, instance) {
        removeLinks(instance);

        db.instances.set(dbArgs, callback);
      });
    });
  } else {
    dbArgs.instance = instance;

    util.invokeExecutable(invokeArgs, function(err, instance) {
      removeLinks(instance);

      db.instances.set(dbArgs, callback);
    });
  }
};

var determineContentType = function(req, res, schema, content, callback) {
  if (schema && schema[req.params.name] &&
      _.isString(schema[req.params.name].content_type)) {
    res.set('Content-Type', schema[req.params.name].content_type);

    callback();
  } else if (Buffer.isBuffer(content)) {
    magicMime.detect(content, function(err, contentType) {
      if (err) return callback(err);

      res.set('Content-Type', contentType);

      callback();
    });
  } else {
    res.set('Content-Type', 'text/plain; charset=utf-8');

    callback();
  }
};

var init = function() {
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

      content = content.replace(/{protocol}/g, req.protocol || 'http');
      content = content.replace(/{host}/g, req.get('Host'));

      res.set('Content-Type', 'text/html').send(content);
    });
  });

  app.get(apiBase + '/spec', function(req, res, next) {
    fs.readFile(path.resolve(__dirname, 'spec.raml'), 'utf8', function(err, content) {
      if (err) return next(err);

      content = content.replace(/{protocol}/g, req.protocol || 'http');
      content = content.replace(/{host}/g, req.get('Host'));

      res.set('Content-Type', 'application/raml+yaml').send(content);
    });
  });

  // executable and invoker routes
  _.each([ 'executable', 'invoker' ], function(str) {
    app.get(apiBase + '/' + str + 's/:' + str + '/instances', getInstances);
    app.post(apiBase + '/' + str + 's/:' + str + '/instances', postInstances);
    app.get(apiBase + '/' + str + 's/:' + str + '/instances/:id', getInstance);
    app.put(apiBase + '/' + str + 's/:' + str + '/instances/:id', putInstance);
    app.delete(apiBase + '/' + str + 's/:' + str + '/instances/:id', deleteInstance);

    app.get(apiBase + '/' + str + 's/:' + str + '/instances/:id/parameters/*', getParameter);
    app.put(apiBase + '/' + str + 's/:' + str + '/instances/:id/parameters/*', putParameter);
    app.delete(apiBase + '/' + str + 's/:' + str + '/instances/:id/parameters/*', deleteParameter);

    app.get(apiBase + '/' + str + 's/:' + str + '/instances/:id/results/*', getResult);
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
};



// Read API spec and finalize app initialization
util.readInput({ specPath: path.join(__dirname, 'apispec.json') }, function(err, as) {
  if (err) throw err;

  apiSpec = as;

  dbConfig.apiSpec = apiSpec;

  db = InstanceDB(dbConfig);

  index._links.spec = { href: '/api/v1/spec' };
  index._links.docs = { href: '/api/v1/docs' };
  index._links.console = { href: '/console/v1' };
  index._links.files = indexFiles;

  init();
});



module.exports = app;
