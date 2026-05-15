import * as cdk from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { CicdPipelineStack } from '../../lib/stacks/cicd-pipeline-stack';

const synth = (): Template => {
  const app = new cdk.App();
  const stack = new CicdPipelineStack(app, 'TestStack', {
    env: { account: '123456789012', region: 'ap-northeast-1' },
    ecsClusterName: 'test-cluster',
    ecsServiceName: 'test-service',
    containerName: 'App',
    taskExecutionRoleArn: 'arn:aws:iam::123456789012:role/test-task-exec-role',
  });
  return Template.fromStack(stack);
};

describe('CicdPipelineStack', () => {
  test('matches snapshot', () => {
    expect(synth().toJSON()).toMatchSnapshot();
  });

  test('ECR repository is immutable and scans on push', () => {
    synth().hasResourceProperties('AWS::ECR::Repository', {
      ImageTagMutability: 'IMMUTABLE',
      ImageScanningConfiguration: { ScanOnPush: true },
    });
  });

  test('Contents bucket is versioned and enables EventBridge notifications', () => {
    const template = synth();
    template.hasResourceProperties(
      'AWS::S3::Bucket',
      Match.objectLike({
        VersioningConfiguration: { Status: 'Enabled' },
      }),
    );
    template.hasResourceProperties(
      'Custom::S3BucketNotifications',
      Match.objectLike({
        NotificationConfiguration: Match.objectLike({
          EventBridgeConfiguration: Match.anyValue(),
        }),
      }),
    );
  });

  test('CodePipeline is V2', () => {
    synth().hasResourceProperties(
      'AWS::CodePipeline::Pipeline',
      Match.objectLike({ PipelineType: 'V2' }),
    );
  });

  test('EventBridge rule targets contents.zip uploads', () => {
    synth().hasResourceProperties(
      'AWS::Events::Rule',
      Match.objectLike({
        EventPattern: Match.objectLike({
          source: ['aws.s3'],
          'detail-type': ['Object Created'],
          detail: Match.objectLike({
            object: Match.objectLike({ key: ['contents.zip'] }),
          }),
        }),
      }),
    );
  });

  test('Pipeline has Source / Build / Deploy stages', () => {
    synth().hasResourceProperties(
      'AWS::CodePipeline::Pipeline',
      Match.objectLike({
        Stages: Match.arrayWith([
          Match.objectLike({ Name: 'Source' }),
          Match.objectLike({ Name: 'Build' }),
          Match.objectLike({ Name: 'Deploy' }),
        ]),
      }),
    );
  });

  test('CodeBuild project is privileged for docker build', () => {
    synth().hasResourceProperties(
      'AWS::CodeBuild::Project',
      Match.objectLike({
        Environment: Match.objectLike({ PrivilegedMode: true }),
      }),
    );
  });
});
