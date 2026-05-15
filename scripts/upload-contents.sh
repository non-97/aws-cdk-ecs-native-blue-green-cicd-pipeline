#!/usr/bin/env bash
#
# contents.zip を tag 付きで ContentsBucket に PUT する。
#
# パイプラインの起動契機となる S3 オブジェクト。中身は html/ ディレクトリで、
# CodeBuild が contents.zip を展開し、 html/ を web コンテナのビルドコンテキスト
# (/tmp/web/html) にコピーしてから docker build する。
#
# 本スクリプトは「html ディレクトリを zip に固める」ところから始め、
# その zip ファイルを S3 にアップロードする。
#
# 使い方:
#   ./scripts/upload-contents.sh <version> <html_directory> [bucket_name] [stack_name]
#
# 例:
#   ./scripts/upload-contents.sh 1.0.0 ./html
#   ./scripts/upload-contents.sh 1.2.3 ./src/container/web/html my-contents-bucket
#   ./scripts/upload-contents.sh 2.0.0 ./html "" CicdPipelineStack

set -euo pipefail

readonly VERSION="${1:?使い方: $0 <version> <html_directory> [bucket_name] [stack_name]}"
readonly HTML_DIR="${2:?使い方: $0 <version> <html_directory> [bucket_name] [stack_name]}"
readonly STACK_NAME="${4:-CicdPipelineStack}"

# EXIT トラップから参照されるため、グローバル変数として宣言する。
# main の local 変数を trap で参照すると、発火時には scope 外で set -u によりエラーになる。
tmp_zip=""
staging_dir=""

#######################################
# 一時ファイル / ディレクトリを片付ける。EXIT トラップから呼ばれる。
#######################################
cleanup() {
  if [[ -n "${tmp_zip}" ]]; then
    rm -f "${tmp_zip}"
  fi
  if [[ -n "${staging_dir}" ]]; then
    rm -rf "${staging_dir}"
  fi
}
trap cleanup EXIT
trap 'echo "ERROR: スクリプトが失敗しました (line ${LINENO}, command: ${BASH_COMMAND})" >&2' ERR

#######################################
# html ディレクトリを contents.zip に固める。
# zip 内が必ず "html/" で始まるように、ステージングディレクトリに固定名でコピー
# してから zip 化する (引数のディレクトリ名が "html" でなくても揃える)。
# Arguments:
#   $1 - 入力となる html ディレクトリのパス
#   $2 - 出力 zip ファイルのパス
# Globals:
#   staging_dir - 作業用一時ディレクトリ (cleanup で削除)
#######################################
zip_html() {
  local html_dir="$1"
  local output_zip="$2"

  if [[ ! -d "${html_dir}" ]]; then
    echo "ERROR: html ディレクトリが見つかりません: ${html_dir}" >&2
    return 1
  fi

  echo "      ステージングディレクトリを作成..."
  staging_dir="$(mktemp -d)"
  echo "      staging_dir=${staging_dir}"

  echo "      html をコピー: ${html_dir} -> ${staging_dir}/html"
  cp -R "${html_dir}" "${staging_dir}/html"

  # mktemp が作った 0 byte の空ファイルが残っていると、zip が「既存ファイルを更新」
  # モードに入り stdin の対話入力を待ってハングする。新規作成扱いにするため削除する。
  rm -f "${output_zip}"

  echo "      zip 化: ${output_zip}"
  (cd "${staging_dir}" && zip -r "${output_zip}" html </dev/null >/dev/null)
}

#######################################
# ContentsBucket 名を解決する。
# 引数で指定があればそれを優先、なければ CloudFormation Outputs から取得する。
# Arguments:
#   $1 - バケット名 (空文字列でも可)
# Outputs:
#   解決したバケット名を STDOUT に出力する。
#######################################
resolve_bucket() {
  local bucket="$1"
  if [[ -n "${bucket}" ]]; then
    echo "${bucket}"
    return
  fi
  aws cloudformation describe-stacks \
    --stack-name "${STACK_NAME}" \
    --query "Stacks[0].Outputs[?OutputKey=='ContentsBucketName'].OutputValue" \
    --output text 2>/dev/null || true
}

main() {
  # 1) html ディレクトリを contents.zip に固める
  echo "[1/3] html ディレクトリを zip に固めています: ${HTML_DIR}"
  tmp_zip="$(mktemp -t contents-XXXXXX.zip)"
  zip_html "${HTML_DIR}" "${tmp_zip}"
  echo "      zip 作成: ${tmp_zip}"

  # 2) アップロード先 ContentsBucket を解決
  echo "[2/3] ContentsBucket を解決しています (引数 or Stack '${STACK_NAME}' の CfnOutput)"
  local bucket
  bucket="$(resolve_bucket "${3:-}")"
  if [[ -z "${bucket}" || "${bucket}" == "None" ]]; then
    echo "ERROR: ContentsBucket 名を解決できませんでした。第 3 引数で指定してください。" >&2
    exit 1
  fi
  echo "      ContentsBucket: ${bucket}"

  # 3) contents.zip を tag 付きでアップロード
  echo "[3/3] S3 にアップロードしています (version=${VERSION})"
  aws s3api put-object \
    --bucket "${bucket}" \
    --key contents.zip \
    --body "${tmp_zip}" \
    --tagging "version=${VERSION}" >/dev/null

  echo "アップロード完了: contents.zip (version=${VERSION}) -> s3://${bucket}/contents.zip"
}

main "$@"
