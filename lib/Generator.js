var path = require('path');
var fs = require('fs-extra');
var async = require('async');
var _ = require('lodash');
var recursive = require('recursive-readdir');



module.exports = function(spec) {
  var obj = {};

  //spec = spec || {};

  var supports = function(apiSpec) { //TODO: additionally support java, java-jersey, java-jaxrs, java-dropwizard
    if (_.contains([ 'node', 'node.js', 'nodejs' ], apiSpec.implementation_type.trim().toLowerCase()) &&
        _.contains([ 'rest', 'restful', 'http-rest' ], apiSpec.interface_type.trim().toLowerCase())) {
      return true;
    } else {
      return false;
    }
  };

  //TODO: merge 'results' defined in apispec.json and invoker.json (invoker overrides apispec)

  var generate = function(apiSpec, done) {
    var implPath = path.resolve(apiSpec.apispec_path, '..', apiSpec.implementation_path);
    var execPath = path.resolve(apiSpec.apispec_path, '..', apiSpec.executable_path);
    var staticPath = path.resolve(implPath, 'static');
    var copiedExecPath = path.resolve(staticPath, 'executable');
    var invokerPath = path.resolve(apiSpec.apispec_path, '..', apiSpec.invoker_path);

    //TODO: if apiSpec.implementation_type starts with 'java', use 'impl-tpl-dropwizard'
    var implTplPath = process.env.IMPL_TEMPLATE_PATH || path.join(__dirname, '..', 'impl-tpl-node');

    async.series([
      async.apply(fs.mkdirs, implPath), //TODO: check if this is needed
      function(callback) {
        if (implPath === implTplPath) callback();
        else fs.copy(implTplPath, implPath, callback);
      },
      async.apply(fs.copy, execPath, copiedExecPath),
      function(callback) {
        // Generate index.json
        recursive(copiedExecPath, function(err, files) {
          if (err) return callback(err);

          var index = {
            _links: {
              self: { href: '/index.json' },
              spec: { href: '/spec.raml' },
              docs: { href: '/docs.html' }
            }
          }

          _.each(files, function(file) {
            index._links[path.relative(copiedExecPath, file)] = { href: '/' + path.relative(staticPath, file) }
          });

          fs.writeFile(path.resolve(staticPath, 'index.json'), JSON.stringify(index, null, 2), callback);
        });
      },
      async.apply(fs.copy, invokerPath, path.join(implPath, 'invoker'))
    ], function(err) {
      if (err) return done(err);

      apiSpec.executable_path = path.join('static', 'executable');
      apiSpec.invoker_path = 'invoker';

      done(null, apiSpec);
    });

    //TODO: generate, details from invoker.json and apispec.json: 'results' etc.
    //   impl/static/api-docs (spec.html)
    //   impl/static/api-spec (spec.raml)
  };

  obj.generate = generate;
  obj.supports = supports;

  return obj;
};
