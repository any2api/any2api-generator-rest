var request = require('supertest');
var chai = require('chai');
var expect = chai.expect;
var yaml = require('js-yaml');
var fs = require('fs');
var path = require('path');
var async = require('async');
var _ = require('lodash');
var S = require('string');
var app = require('../app');

var host = process.env.HOST || ''; // 'http://localhost:3000'

var baseUrl = host + '/api/v1';

var emptyInstance = { parameters: {} };

var interval = 1000 * 5; // 5 seconds
var timeout = 1000 * 60 * 15; // 15 minutes



describe('minimum test', function() {
  this.timeout(timeout);

  var endpoints = [];

  before('get endpoints', function(done) {
    var specRamlPath = path.resolve(__dirname, '..', 'spec.raml');

    fs.readFile(specRamlPath, 'utf8', function(err, content) {
      if (err) throw err;

      var specRaml = yaml.safeLoad(content);

      _.each(specRaml, function(ep, epPath) {
        if (S(epPath).startsWith('/executables')) {
          endpoints.push(baseUrl + epPath);
        }
      });

      done();
    });
  });

  it('run executables with default parameters', function(done) {
    async.eachSeries(endpoints, performRequest, function(err) {
      if (err) throw err;

      done();
    });
  });
});



var performRequest = function(url, done) {
  request(app)
    .post(url)
    .send(emptyInstance)
    .set('Accept', 'application/json')
    .expect('Content-Type', /json/)
    .expect(201)
    .end(function(err, res) {
      if (err) throw err;
      
      expect(res.header.location).to.exist;
      expect(res.body.status).to.equal('running');

      var intervalObj = setInterval(function() {
        request(app)
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
