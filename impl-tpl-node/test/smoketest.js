var request = require('supertest');
var chai = require('chai');
var expect = chai.expect;
var app = require('../app');

var host = process.env.HOST || ''; // 'http://localhost:3000'

var baseUrl = host + '/api/v1';
var interval = 3000; // 3 seconds
var timeout = 1000 * 60 * 6; // 6 minutes

var testRun = {
  parameters: {
    invoker_config: {
      max_runs: 1
    }
  }
};



describe('smoke test', function() {
  this.timeout(timeout);

  it('invoke executable with default parameters', function(done) {
    request(app)
      .post(baseUrl + '/runs')
      .send(testRun)
      .set('Accept', 'application/json')
      .expect('Content-Type', /json/)
      .expect(201)
      .end(function(err, res) {
        if (err) throw err;
        
        expect(res.header.location).to.exist;
        expect(res.body.status).to.equal('running');

        setInterval(function() {
          request(app)
            .get(res.header.location)
            .set('Accept', 'application/json')
            .expect('Content-Type', /json/)
            .expect(200)
            .end(function(err, res) {
              if (err) throw err;

              if (res.body.status === 'error') {
                console.log(res.body);

                expect(res.body.results.stdout).to.exist;
                expect(res.body.results.stderr).to.exist;
                expect(res.body.error).to.exist;
                expect(res.body.failed).to.exist;

                done();
              } else if (res.body.status === 'finished') {
                console.log(res.body);

                expect(res.body.results).to.exist;
                expect(res.body.finished).to.exist;

                done();
              } else if (res.body.status === 'running') {
                // do nothing
              } else {
                console.error(res.body);

                throw new Error('unknown status');
              }
          });
        }, interval);
    });
  });
});
