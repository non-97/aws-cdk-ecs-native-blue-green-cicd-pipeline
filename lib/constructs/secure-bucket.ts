import * as cdk from 'aws-cdk-lib/core';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface SecureBucketProps {
  /**
   * EventBridge へのオブジェクト変更通知を有効化するか
   *
   * @default false
   */
  readonly eventBridgeEnabled?: boolean;
}

export class SecureBucket extends s3.Bucket {
  constructor(scope: Construct, id: string, props: SecureBucketProps = {}) {
    super(scope, id, {
      versioned: true,
      eventBridgeEnabled: props.eventBridgeEnabled ?? false,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
  }
}
