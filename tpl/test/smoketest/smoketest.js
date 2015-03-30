var request = require('supertest');
var chai = require('chai');
var expect = chai.expect;
var fs = require('fs');
var path = require('path');
var async = require('async');
var _ = require('lodash');

var baseAddress = process.env.BASE_ADDRESS || 'http://localhost:3000';
var baseUrl = baseAddress + '/api/v1';

var invokerName = process.env.INVOKER_NAME;
var invokerUrl = baseUrl + '/invokers/' + invokerName + '/instances';

var executableName = process.env.EXECUTABLE_NAME;
var executableUrl = baseUrl + '/executables/' + executableName + '/instances';

var interval = 1000 * 5; // 5 seconds
var timeout = 1000 * 60 * 15; // 15 minutes

var instanceLocalEmpty = { parameters: {} };

var instanceLocalEmbedded = {
  "parameters": {
    "run_list": [
      "recipe[embedded]"
    ],
    "invoker_config": {
      "access": "local"
    }
  },
  "executable": {
    //"name": "embedded",
    "files": [
      {
        "path": "metadata.json",
        "object": {
          "name": "embedded",
          "dependencies": {
            "mysql": "= 5.6.1"
          }
        }
      },
      {
        "path": "recipes/default.rb",
        "text": "include_recipe \"mysql::server\"\n"
      },
      {
        "path": "README.md",
        "url": "https://raw.githubusercontent.com/any2api/any2api-cli/master/README.md"
      }
    ]
  }
};

var instanceSshEmpty = _.cloneDeep(instanceLocalEmpty);
instanceSshEmpty.parameters = _.extend(instanceSshEmpty.parameters, { invoker_config: {
  access: 'ssh',
  ssh_port: process.env.SSH_PORT || 22,
  ssh_host: process.env.SSH_HOST || 'localhost',
  ssh_user: process.env.SSH_USER || 'ubuntu',
  ssh_private_key: process.env.SSH_PRIVATE_KEY || 'none'
} });

var instanceSshEmbedded = _.cloneDeep(instanceLocalEmbedded);
instanceSshEmbedded.parameters = _.extend(instanceSshEmbedded.parameters, { invoker_config: {
  access: 'ssh',
  ssh_port: process.env.SSH_PORT || 22,
  ssh_host: process.env.SSH_HOST || 'localhost',
  ssh_user: process.env.SSH_USER || 'ubuntu',
  ssh_private_key: process.env.SSH_PRIVATE_KEY || 'none'
  //,share_connection: false
} });



describe('smoke test', function() {
  this.timeout(timeout);

  it('run registered executable on localhost', function(done) {
    if (!executableName) return done();

    performRequest(executableUrl, instanceLocalEmpty, function(err) {
      if (err) throw err;

      done();
    });
  });

  it('run embedded executable on localhost', function(done) {
    if (!invokerName) return done();

    performRequest(invokerUrl, instanceLocalEmbedded, function(err) {
      if (err) throw err;

      done();
    });
  });

  it('run registered executable remotely through SSH', function(done) {
    if (!executableName) return done();

    performRequest(executableUrl, instanceSshEmpty, function(err) {
      if (err) throw err;

      done();
    });
  });

  it('run embedded executable remotely through SSH', function(done) {
    if (!invokerName) return done();

    performRequest(invokerUrl, instanceSshEmbedded, function(err) {
      if (err) throw err;

      done();
    });
  });
});



var performRequest = function(url, instance, done) {
  request(url)
    .post('/')
    .send(instance)
    .set('Accept', 'application/json')
    .expect('Content-Type', /json/)
    .expect(201)
    .end(function(err, res) {
      if (err) throw err;
      
      expect(res.header.location).to.exist;
      expect(res.body.status).to.equal('running');

      var intervalObj = setInterval(function() {
        request(baseAddress)
          .get(res.header.location)
          .query({ embed_all_params: 'true' })
          .query({ embed_all_results: 'true' })
          .set('Accept', 'application/json')
          .expect('Content-Type', /json/)
          .expect(200)
          .end(function(err, res) {
            if (err) throw err;

            if (res.body.status === 'running') return;

            if (res.body.status === 'error') {
              console.log(res.body);

              expect(res.body.error).to.exist;
              expect(res.body.failed).to.exist;
            } else if (res.body.status === 'finished') {
              console.log(res.body);

              expect(res.body.results).to.exist;
              expect(res.body.finished).to.exist;
            } else {
              console.error(res.body);

              throw new Error('unknown status');
            }

            intervalObj.close();
            done();
        });
      }, interval);
  });
};
