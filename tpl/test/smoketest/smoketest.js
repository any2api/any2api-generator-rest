var request = require('supertest');
var chai = require('chai');
var expect = chai.expect;
var fs = require('fs');
var path = require('path');
var async = require('async');
var _ = require('lodash');

var host = process.env.HOST || 'http://localhost:3000';
var baseUrl = host + '/api/v1';

var invokerName = process.env.INVOKER_NAME;
var invokerUrl = baseUrl + '/invokers/' + invokerName + '/runs';

var executableName = process.env.EXECUTABLE_NAME;
var executableUrl = baseUrl + '/executables/' + executableName + '/runs';

var interval = 1000 * 5; // 5 seconds
var timeout = 1000 * 60 * 15; // 15 minutes

var runLocalEmpty = { parameters: {} };

var runLocalEmbedded = {
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
            "mysql": ">= 0.0.0"
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

var runSshEmpty = _.cloneDeep(runLocalEmpty);
runSshEmpty.parameters = _.extend(runSshEmpty.parameters, { invoker_config: {
  access: 'ssh',
  ssh_port: process.env.SSH_PORT || 22,
  ssh_host: process.env.SSH_HOST || 'localhost',
  ssh_user: process.env.SSH_USER || 'ubuntu',
  ssh_private_key: process.env.SSH_PRIVATE_KEY || 'none'
} });

var runSshEmbedded = _.cloneDeep(runLocalEmbedded);
runSshEmbedded.parameters = _.extend(runSshEmbedded.parameters, { invoker_config: {
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

    performRequest(executableUrl, runLocalEmpty, function(err) {
      if (err) throw err;

      done();
    });
  });

  it('run embedded executable on localhost', function(done) {
    if (!invokerName) return done();

    performRequest(invokerUrl, runLocalEmbedded, function(err) {
      if (err) throw err;

      done();
    });
  });

  it('run registered executable remotely through SSH', function(done) {
    if (!executableName) return done();

    performRequest(executableUrl, runSshEmpty, function(err) {
      if (err) throw err;

      done();
    });
  });

  it('run embedded executable remotely through SSH', function(done) {
    if (!invokerName) return done();

    performRequest(invokerUrl, runSshEmbedded, function(err) {
      if (err) throw err;

      done();
    });
  });
});



var performRequest = function(url, run, done) {
  request(url)
    .post('/')
    .send(run)
    .set('Accept', 'application/json')
    .expect('Content-Type', /json/)
    .expect(201)
    .end(function(err, res) {
      if (err) throw err;
      
      expect(res.header.location).to.exist;
      expect(res.body.status).to.equal('running');

      var intervalObj = setInterval(function() {
        request(host)
          .get(res.header.location)
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
