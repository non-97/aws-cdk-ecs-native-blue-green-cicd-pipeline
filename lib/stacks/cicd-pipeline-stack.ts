import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib/core';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import {
  DeploymentPipeline,
  SecureBucket,
  SecureEcrRepository,
} from '../constructs';

export interface CicdPipelineStackProps extends cdk.StackProps {
  readonly ecsClusterName: string;
  readonly ecsServiceName: string;
  readonly containerName: string;
  readonly taskExecutionRoleArn: string;
}

export class CicdPipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: CicdPipelineStackProps) {
    super(scope, id, props);

    const ecrRepository = new SecureEcrRepository(this, 'EcrRepository');

    // ECS の TaskExecutionRole は CDK 管理外なので identity policy を書き換えられない。
    // 同一アカウント内なので grantPull は何もしてくれず、明示的に ECR の Repository Policy
    // (resource-based) にステートメントを追加することで、当該 Role からの pull を許可する。
    ecrRepository.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowPullFromTaskExecutionRole',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ArnPrincipal(props.taskExecutionRoleArn)],
        actions: [
          'ecr:BatchCheckLayerAvailability',
          'ecr:GetDownloadUrlForLayer',
          'ecr:BatchGetImage',
        ],
      }),
    );

    const contentsBucket = new SecureBucket(this, 'ContentsBucket', {
      eventBridgeEnabled: true,
    });

    const buildAssetsBucket = new SecureBucket(this, 'BuildAssetsBucket');

    new s3deploy.BucketDeployment(this, 'WebAssetsDeployment', {
      sources: [
        s3deploy.Source.asset(path.join(__dirname, '..', '..', 'assets', 'web')),
      ],
      destinationBucket: buildAssetsBucket,
      destinationKeyPrefix: 'web',
      retainOnDelete: false,
      prune: true,
    });

    new DeploymentPipeline(this, 'DeploymentPipeline', {
      ecrRepository,
      contentsBucket,
      buildAssetsBucket,
      ecsClusterName: props.ecsClusterName,
      ecsServiceName: props.ecsServiceName,
      containerName: props.containerName,
    });

    new cdk.CfnOutput(this, 'ContentsBucketName', {
      value: contentsBucket.bucketName,
    });
  }
}
