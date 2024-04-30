const path = require('path')
const aws = require('aws-sdk')
const AwsSdkLambda = aws.Lambda
const { mergeDeepRight, pick } = require('ramda')
const { Component, utils } = require('@serverless/core')
const {
  createLambda,
  updateLambdaCode,
  updateLambdaConfig,
  getLambda,
  deleteLambda,
  configChanged,
  pack,  
  waitUntilReady
} = require('./utils')

const outputsList = [
  'name',
  'hash',
  'description',
  'memory',
  'timeout',
  'code',
  'bucket',
  'shims',
  'handler',
  'runtime',
  'architectures',
  'env',
  'role',
  'layer',
  'arn',
  'region'
]

const defaults = {
  description: 'AWS Lambda Component',
  memory: 512,
  timeout: 10,
  code: process.cwd(),
  bucket: undefined,
  shims: [],
  handler: 'handler.hello',
  runtime: 'nodejs18.x',
  architectures:["arm64"],
  env: {},
  region: 'us-east-1',
  tracingConfig: {
    Mode: 'PassThrough'
  },
}

class AwsLambda extends Component {
  async default(inputs = {}) {
    this.context.status(`Deploying`);

    const config = mergeDeepRight(defaults, inputs)
    config.name = this.state.name || inputs.name || this.context.resourceId()

    this.context.debug(
      `Starting deployment of lambda ${config.name} to the ${config.region} region.`
    )

    const lambda = new AwsSdkLambda({
      region: config.region,
      credentials: this.context.credentials.aws,
      maxRetries: 10
    })

    const awsIamRole = await this.load('@serverless/aws-iam-role')

    // If no role exists, create a default role
    let outputsAwsIamRole
    if (!config.role) {
      this.context.debug(`No role provided for lambda ${config.name}.`)

      outputsAwsIamRole = await awsIamRole({
        service: 'lambda.amazonaws.com',
        policy: {
          arn: 'arn:aws:iam::aws:policy/AdministratorAccess'
        },
        region: config.region
      })
      config.role = { arn: outputsAwsIamRole.arn }
    } else {
      outputsAwsIamRole = await awsIamRole(config.role)
      config.role = { arn: outputsAwsIamRole.arn }
    }

    this.context.status('Packaging')
    this.context.debug(`Packaging lambda code from ${config.code}.`)
    
    config.zipPath = await pack(config.code, config.shims)
    config.hash = await utils.hashFile(config.zipPath);  

    const prevLambda = await getLambda({ lambda, ...config })   

    if (!prevLambda) {     
      this.context.debug(`Creating lambda ${config.name} in the ${config.region} region.`)
      const createResult = await createLambda({ lambda, ...config })
      config.arn = createResult.arn
      config.hash = createResult.hash
      await waitUntilReady(lambda, this.context, config.name);
    } else {
      config.arn = prevLambda.arn
      if (configChanged(prevLambda, config)) {
        if ((prevLambda.architectures[0] !== config.architectures[0]) || (!config.bucket && prevLambda.hash !== config.hash)) {
          this.context.debug(`Uploading ${config.name} lambda code.`)
          await updateLambdaCode({ lambda, ...config })
          await waitUntilReady(lambda, this.context, config.name);
        }       
        try {      
          this.context.debug(`Updating ${config.name} lambda config.`);
          const updateResult = await updateLambdaConfig({ lambda, ...config });
          this.context.debug(`Lambda config for ${config.description} updated.`);
          config.hash = updateResult.hash;
          await waitUntilReady(lambda, this.context, config.name);
        }
        catch(e){
           console.error(e);
        }        
      }
    }

    // todo we probably don't need this logic now that we auto generate names
    if (this.state.name && this.state.name !== config.name) {
      this.context.status(`Replacing`)
      await deleteLambda({ lambda, name: this.state.name })
    }

    this.context.debug(
      `Successfully deployed lambda ${config.name} in the ${config.region} region.`
    )

    const outputs = pick(outputsList, config)
    this.state = outputs
    await this.save()
    return outputs
  }

  async publishVersion() {
    const { name, region, hash } = this.state   
    const lambda = new AwsSdkLambda({
      region,
      credentials: this.context.credentials.aws,
      maxRetries: 10
    })    
    try{     
      const { Version } = await lambda.publishVersion({ FunctionName: name, CodeSha256: hash }).promise();
      return { version:Version };
    }
    catch(e){
      console.error(`Error publishing ${name} - ${e.stack || e}`);
      return { version:'' };
    }    
  }

  async createAlias({ alias, version }) {

    const { name, region } = this.state

    const lambda = new AwsSdkLambda({
      region,
      credentials: this.context.credentials.aws,
      maxRetries: 10
    })

    try {
      await lambda
        .createAlias({
          FunctionName: name,
          Name: alias,
          FunctionVersion: version
        })
        .promise()
    }
    catch (e) {
      if (e.code === 'ResourceConflictException') {
        this.context.debug('Alias already exists. Cool.')
        return;
      }
      // otherwise bounce
      throw Error(e)
    }
  }

  async remove() {
    this.context.status(`Removing`)

    if (!this.state.name) {
      this.context.debug(`Aborting removal. Function name not found in state.`)
      return
    }

    const { name, region } = this.state

    const lambda = new AwsSdkLambda({
      region,
      credentials: this.context.credentials.aws,
      maxRetries: 10
    })

    const awsIamRole = await this.load('@serverless/aws-iam-role')
    const layer = await this.load('@serverless/aws-lambda-layer')

    await awsIamRole.remove()
    await layer.remove()

    this.context.debug(`Removing lambda ${name} from the ${region} region.`)
    await deleteLambda({ lambda, name })
    this.context.debug(`Successfully removed lambda ${name} from the ${region} region.`)

    const outputs = pick(outputsList, this.state)

    this.state = {}
    await this.save()
    return outputs
  }
}

module.exports = AwsLambda
