#%RAML 0.8
title: <%= title %>
baseUri: '{protocol}://{host}/api/v1'
version: v1
#uriParameters:
#  host:
#    description: The host of the API (e.g., 'localhost')
#    displayName: Host
#    type: string
#  port:
#    description: The port on the host where the API is served (e.g., 8080)
#    displayName: Port
#    type: number

schemas:
<% _.forEach(_.map(invokers).concat(_.map(executables)), function(item) { %>
  - <%= item.rest_schema_name %>: |
<%= item.rest_schema %>
<% }); %>

  - instanceCollection: |
      {
        "$schema": "http://json-schema.org/draft-04/schema#",
        "type": "array",
        "description": "List of instances"
      }


documentation:
<% _.forEach(docs, function(doc) { %>
  - title: <%= doc.title %>
    content: |
<%= doc.content %>
<% }); %>


<% _.forEach(_.map(invokers).concat(_.map(executables)), function(item) { %>
/<%= item.rest_url_path %>/instances:
  get:
    description: List all instances
    queryParameters:
      status:
        type: string
        description: "Filter instances by status ('prepare', 'running', 'finished', etc.)"
        example: running
        required: false
    responses:
      200:
        body:
          application/json:
            schema: instanceCollection
  post:
    description: Add a new instance
    body:
      application/json:
        schema: <%= item.rest_schema_name %>
        example: |
<%= item.rest_req_example %>
    responses:
      201:
        body:
          application/json:
            schema: <%= item.rest_schema_name %>
            example: |
<%= item.rest_res_example %>

  /{instance_id}:
    get:
      description: Get instance details
      queryParameters:
        embed_all_params:
          type: boolean
          description: Include all parameters of this instance in response
          default: false
          example: true
          required: false
        embed_param:
          type: string
          description: Include given parameter(s) of this instance in response
          example: invoker_config
          required: false
          repeat: true
        embed_all_results:
          type: boolean
          description: Include all results of this instance in response
          default: false
          example: true
          required: false
        embed_result:
          type: string
          description: Include given result(s) of this instance in response
          example: logs
          required: false
          repeat: true
      responses:
        200:
          body:
            application/json:
              schema: <%= item.rest_schema_name %>
              example: |
<%= item.rest_res_example %>
        404:
          body:
            application/json:
              example: |
                { "message": "instance missing" }
    put:
      description: "Update instance to set status to 'running'"
      body:
        application/json:
          schema: <%= item.rest_schema_name %>
          example: |
            { "status": "running" }
      responses:
        200:
          body:
            application/json:
              schema: <%= item.rest_schema_name %>
              example: |
<%= item.rest_res_example %>
    delete:
      description: Delete instance permanently

    /parameters/{parameter_name}:
      put:
        description: Put raw content of parameter
      get:
        description: Get raw content of parameter
      delete:
        description: Delete parameter

    /results/{result_name}:
      get:
        description: Get raw content of result

<% }); %>
