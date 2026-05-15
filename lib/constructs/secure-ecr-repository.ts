import * as cdk from 'aws-cdk-lib/core';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';

export interface SecureEcrRepositoryProps {
  /**
   * ライフサイクルポリシーで保持する最大イメージ数
   *
   * @default 10
   */
  readonly maxImageCount?: number;
}

export class SecureEcrRepository extends ecr.Repository {
  constructor(scope: Construct, id: string, props: SecureEcrRepositoryProps = {}) {
    super(scope, id, {
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      imageScanOnPush: true,
      encryption: ecr.RepositoryEncryption.AES_256,
      lifecycleRules: [
        {
          maxImageCount: props.maxImageCount ?? 10,
          tagStatus: ecr.TagStatus.ANY,
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
  }
}
