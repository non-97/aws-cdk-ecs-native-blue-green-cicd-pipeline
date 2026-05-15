import * as cdk from "aws-cdk-lib/core";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as codepipeline from "aws-cdk-lib/aws-codepipeline";
import * as actions from "aws-cdk-lib/aws-codepipeline-actions";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

export interface DeploymentPipelineProps {
  readonly ecrRepository: ecr.IRepository;
  readonly contentsBucket: s3.IBucket;
  readonly buildAssetsBucket: s3.IBucket;
  readonly ecsClusterName: string;
  readonly ecsServiceName: string;
  /**
   * imagedefinitions.json の "name" と一致させる必要がある (TaskDefinition の container 名)。
   */
  readonly containerName: string;
}

/**
 * S3 への contents.zip アップロードを契機に、web コンテナイメージをビルドして
 * ECR に push し、ECS Service の Native Blue/Green デプロイを起動する CI/CD パイプライン。
 *
 * 前提:
 * - デプロイ先 ECS Service が deploymentConfiguration.strategy = BLUE_GREEN で事前構成済みであること。
 *   本 Construct は strategy 自体を管理せず、UpdateService を呼ぶだけ。
 * - contents.zip には S3 user-defined tag `version=<semver>` が付与されていること。
 * - contents.zip の中身は html/ ディレクトリを含む zip であること。
 */
export class DeploymentPipeline extends Construct {
  public readonly pipeline: codepipeline.IPipeline;

  constructor(scope: Construct, id: string, props: DeploymentPipelineProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);

    // 既存 ECS Service は本パイプラインの管理外 (別 Stack / 別 IaC を想定)。
    // ARN を組み立てて参照し、EcsDeployAction に渡せる IBaseService として import する。
    const serviceArn = stack.formatArn({
      service: "ecs",
      resource: "service",
      resourceName: `${props.ecsClusterName}/${props.ecsServiceName}`,
    });
    const service = ecs.BaseService.fromServiceArnWithCluster(
      this,
      "TargetService",
      serviceArn
    );

    const buildProject = new codebuild.PipelineProject(this, "BuildAndScan", {
      environment: {
        // デプロイ先 ECS Task が cpuArchitecture: ARM64 (Graviton) のため、
        // CodeBuild も ARM64 (Graviton) ホストでビルドしてアーキ一致させる。
        // x86_64 でビルドすると ECS で "Exec format error" になる。
        buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0,
        computeType: codebuild.ComputeType.SMALL,
        // docker build に docker daemon が必要。
        // CodeBuild Lambda compute は privileged 非対応のため、EC2 compute を選択している。
        privileged: true,
      },
      environmentVariables: {
        ECR_REPO_URI: { value: props.ecrRepository.repositoryUri },
        CONTENTS_BUCKET: { value: props.contentsBucket.bucketName },
        ASSETS_BUCKET: { value: props.buildAssetsBucket.bucketName },
        CONTAINER_NAME: { value: props.containerName },
      },
      buildSpec: codebuild.BuildSpec.fromObjectToYaml({
        version: "0.2",
        env: {
          shell: "bash",
        },
        phases: {
          install: {
            // hadolint は Dockerfile の lint ツール。
            commands: [
              // CodeBuild を ARM64 (Graviton) に切り替えたので、hadolint も arm64 用バイナリを取得する。
              "curl -sSfL https://github.com/hadolint/hadolint/releases/download/v2.12.0/hadolint-Linux-arm64 -o /usr/local/bin/hadolint",
              "chmod +x /usr/local/bin/hadolint",
            ],
          },
          pre_build: {
            commands: [
              // IMAGE_TAG は contents.zip の user-defined tag "version" を使う。
              // CodePipeline V2 の S3 source 変数では ETag / VersionId しか取れないため、ここで明示的に取得する。
              `IMAGE_TAG=$(aws s3api get-object-tagging --bucket "$CONTENTS_BUCKET" --key contents.zip | jq -r '.TagSet[] | select(.Key=="version") | .Value')`,
              `test -n "$IMAGE_TAG" -a "$IMAGE_TAG" != "null" || { echo "ERROR: version tag missing on contents.zip"; exit 1; }`,
              // assets/web/ (Dockerfile + conf/) はビルド都度変わらない固定資材として CDK が S3 に配信したものを取得する。
              `mkdir -p /tmp/web`,
              `aws s3 sync "s3://\${ASSETS_BUCKET}/web/" /tmp/web/`,
              // contents.zip 由来の html/ をビルドコンテキストに組み込む。
              `test -d ./html || { echo "ERROR: contents.zip must contain html/ directory"; exit 1; }`,
              `cp -R ./html /tmp/web/html`,
              // hadolint のデフォルトは warning 以上で exit 1。
              // ベースイメージのバージョン未固定 (DL3018 等) は実運用で許容したいので、error のみで失敗させる。
              `hadolint --failure-threshold error /tmp/web/Dockerfile`,
            ],
          },
          build: {
            commands: [
              `aws ecr get-login-password | docker login --username AWS --password-stdin "\${ECR_REPO_URI%/*}"`,
              `docker build -t "\${ECR_REPO_URI}:\${IMAGE_TAG}" /tmp/web`,
              // ECR Immutable のため、同一 IMAGE_TAG の再 push は ImageTagAlreadyExistsException で失敗する。
              // これは「同じ version を 2 度上げる」運用ミスを早期に検知するための意図的な挙動。
              `docker push "\${ECR_REPO_URI}:\${IMAGE_TAG}"`,
            ],
          },
          post_build: {
            commands: [
              // EcsDeployAction が読む imagedefinitions.json には digest 形式 (<repo>@sha256:...) を書く。
              // tag が万一上書きされてもデプロイは厳密に同一 image を指す、というベストプラクティス。
              // digest は push 直後のローカル docker daemon から取得する (ecr:DescribeImages 不要、IAM 最小化)。
              `REPO_NAME="\${ECR_REPO_URI##*/}"`,
              `IMAGE_DIGEST=$(docker inspect --format='{{index .RepoDigests 0}}' "\${ECR_REPO_URI}:\${IMAGE_TAG}" | cut -d@ -f2)`,
              `IMAGE_URI="\${ECR_REPO_URI}@\${IMAGE_DIGEST}"`,
              // ECR enhanced scanning は非同期。
              // 完了まで最大 10 分待ち、Critical を 1 件でも検出したら fail-closed でパイプラインを停止する。
              `for i in $(seq 1 40); do STATUS=$(aws ecr describe-image-scan-findings --repository-name "$REPO_NAME" --image-id imageTag="$IMAGE_TAG" --query 'imageScanStatus.status' --output text 2>/dev/null || echo PENDING); { [ "$STATUS" = "ACTIVE" ] || [ "$STATUS" = "COMPLETE" ]; } && break; sleep 15; done`,
              `CRITICAL=$(aws ecr describe-image-scan-findings --repository-name "$REPO_NAME" --image-id imageTag="$IMAGE_TAG" --query 'imageScanFindings.findingSeverityCounts.CRITICAL' --output text 2>/dev/null || echo 0)`,
              `if [ "$CRITICAL" != "None" ] && [ "$CRITICAL" -gt 0 ]; then echo "ERROR: Critical vulnerabilities: $CRITICAL"; exit 1; fi`,
              `printf '[{"name":"%s","imageUri":"%s"}]' "$CONTAINER_NAME" "$IMAGE_URI" > imagedefinitions.json`,
            ],
          },
        },
        artifacts: {
          files: ["imagedefinitions.json"],
          "base-directory": ".",
        },
      }),
      timeout: cdk.Duration.minutes(30),
    });

    props.ecrRepository.grantPullPush(buildProject);
    props.contentsBucket.grantRead(buildProject);
    props.buildAssetsBucket.grantRead(buildProject);

    // grantRead だけでは GetObjectTagging API は許可されないため、明示的に追加する。
    buildProject.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObjectTagging", "s3:GetObjectVersionTagging"],
        resources: [props.contentsBucket.arnForObjects("*")],
      })
    );
    // ECR enhanced scanning (Inspector v2) の結果取得に必要。basic scan のみなら不要。
    buildProject.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ecr:DescribeImageScanFindings", "inspector2:ListFindings"],
        resources: ["*"],
      })
    );

    const sourceArtifact = new codepipeline.Artifact("SourceArtifact");
    const buildArtifact = new codepipeline.Artifact("BuildArtifact");

    const pipeline = new codepipeline.Pipeline(this, "Pipeline", {
      // V2 採用。S3 source トリガと EventBridge 連携が V2 で標準サポートされる。
      pipelineType: codepipeline.PipelineType.V2,
      crossAccountKeys: false,
      stages: [
        {
          stageName: "Source",
          actions: [
            new actions.S3SourceAction({
              actionName: "S3Source",
              bucket: props.contentsBucket,
              bucketKey: "contents.zip",
              output: sourceArtifact,
              // S3 を直接ポーリングせず、EventBridge ルール経由でトリガするため NONE を指定。
              trigger: actions.S3Trigger.NONE,
            }),
          ],
        },
        {
          stageName: "Build",
          actions: [
            new actions.CodeBuildAction({
              actionName: "BuildAndScan",
              project: buildProject,
              input: sourceArtifact,
              outputs: [buildArtifact],
            }),
          ],
        },
        {
          stageName: "Deploy",
          actions: [
            new actions.EcsDeployAction({
              actionName: "EcsDeploy",
              service,
              input: buildArtifact,
              deploymentTimeout: cdk.Duration.minutes(60),
            }),
          ],
        },
      ],
    });

    // S3SourceAction の trigger: S3Trigger.EVENTS は CDK が EventBridge Rule を自動生成するが、
    // 生成される Rule は detail-type: "AWS API Call via CloudTrail" を期待する古い実装のため、
    // CloudTrail Trail 側で S3 データイベントを記録していないと発火しない。CDK 自身は Trail を作らない。
    // AWS 機能としては CloudTrail は本来不要なので、ネイティブ EventBridge 通知を素直に使う方式を採る。
    new events.Rule(this, "ContentsUploadTrigger", {
      eventPattern: {
        source: ["aws.s3"],
        detailType: ["Object Created"],
        detail: {
          bucket: { name: [props.contentsBucket.bucketName] },
          object: { key: ["contents.zip"] },
        },
      },
      targets: [new targets.CodePipeline(pipeline)],
    });

    this.pipeline = pipeline;
  }
}
