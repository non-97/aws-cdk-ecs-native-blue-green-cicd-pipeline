import { Environment } from "aws-cdk-lib";

export interface AppConfig {
  readonly env: Required<Pick<Environment, "account" | "region">>;
  readonly ecsClusterName: string;
  readonly ecsServiceName: string;
  readonly containerName: string;
  /**
   * デプロイ先 ECS Service の TaskExecutionRole の ARN。
   * 本 CI/CD で push する ECR リポジトリからの pull を許可するために、
   * ECR Repository Policy に当該 Role を principal として加える。
   */
  readonly taskExecutionRoleArn: string;
}

export const appConfig: AppConfig = {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT ?? "",
    region: process.env.CDK_DEFAULT_REGION ?? "",
  },
  ecsClusterName:
    "EcsNativeBlueGreenStack-EcsConstructCluster14AE103B-QcxfcpKlnX3a",
  ecsServiceName:
    "EcsNativeBlueGreenStack-EcsConstructServiceC04CE253-tgZbD9nkbjuL",
  containerName: "web",
  taskExecutionRoleArn:
    "arn:aws:iam::<AWS account ID>:role/EcsNativeBlueGreenStack-EcsConstructTaskDefinitionE-gzMOH9PLYKeg",
};
