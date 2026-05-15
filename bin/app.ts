#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { appConfig } from '../lib/config/app-config';
import { CicdPipelineStack } from '../lib/stacks/cicd-pipeline-stack';

const app = new cdk.App();
new CicdPipelineStack(app, 'CicdPipelineStack', {
  env: appConfig.env,
  ecsClusterName: appConfig.ecsClusterName,
  ecsServiceName: appConfig.ecsServiceName,
  containerName: appConfig.containerName,
  taskExecutionRoleArn: appConfig.taskExecutionRoleArn,
});
