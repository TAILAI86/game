#!/usr/bin/env python3
"""通过 GitHub Git Data API 推送提交并创建 Pull Request。

背景：本机代理对 github.com（git 主机）持续返回 502 / CONNECT tunnel failed，
而 api.github.com 可达，因此改用 API 走 GitHub 的底层 Git 数据接口，
构造与本地完全一致的提交对象（同样的 tree / parent / author / message），
使远端 commit SHA 与本地一致，后续 git 状态依然干净。

用法：
    python _dev/push_via_api.py --branch feat/xxx --title "..." --body "..."
"""
import argparse
import base64
import json
import os
import subprocess
import sys
import urllib.request

API = "https://api.github.com"
REPO = "TAILAI86/game"
# 必须是仓库根目录：git ls-tree / diff-tree 在子目录里执行会带上 cwd 前缀，
# 产出的路径是相对子目录的，拼出来的 tree 结构会错。
REPO_DIR = subprocess.run(
    ["git", "-C", os.path.dirname(os.path.abspath(__file__)), "rev-parse", "--show-toplevel"],
    capture_output=True).stdout.decode("utf-8", "replace").strip()
if not REPO_DIR:
    raise SystemExit("cannot locate git repo root")


def api(path, method="GET", body=None, token=None):
    url = path if path.startswith("http") else API + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    req.add_header("User-Agent", "game-push")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    if data:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=60) as r:
        raw = r.read()
    return json.loads(raw) if raw else None


def git(*args, binary=False):
    out = subprocess.run(["git", "-C", REPO_DIR] + list(args), capture_output=True)
    if out.returncode != 0:
        raise SystemExit("git %s failed: %s" % (" ".join(args), out.stderr.decode("utf-8", "replace")))
    return out.stdout if binary else out.stdout.decode("utf-8", "replace")


def get_token():
    tok = subprocess.run(
        ["git", "credential", "fill"], input=b"protocol=https\nhost=github.com\n\n",
        capture_output=True).stdout.decode("utf-8", "replace")
    for line in tok.splitlines():
        if line.startswith("password="):
            return line.split("=", 1)[1].strip()
    raise SystemExit("no credential found")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--branch", required=True)
    ap.add_argument("--title", required=True)
    ap.add_argument("--body", default="")
    ap.add_argument("--base", default="main")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    token = get_token()
    print("token acquired (len=%d)" % len(token))

    head = git("rev-parse", "HEAD").strip()
    parent = git("rev-parse", "HEAD~1").strip()
    tree = git("rev-parse", "HEAD^{tree}").strip()
    parent_tree = git("rev-parse", "HEAD~1^{tree}").strip()
    message = git("log", "-1", "--format=%B").rstrip("\n")
    author = git("log", "-1", "--format=%an%n%ae%n%aI").splitlines()
    committer = git("log", "-1", "--format=%cn%n%ce%n%cI").splitlines()
    print("local HEAD   =", head)
    print("local parent =", parent)

    # 远端基线分支必须等于本地父提交，否则不能快进
    base_ref = api("/repos/%s/git/ref/heads/%s" % (REPO, args.base), token=token)
    remote_base = base_ref["object"]["sha"]
    print("remote %s =" % args.base, remote_base)
    if remote_base != parent:
        raise SystemExit("remote %s %s != local parent %s — refusing" % (args.base, remote_base, parent))

    # 目标分支：不存在则创建（指向父提交），存在则校验能否快进
    # 注意：GET/PATCH 用 "heads/<branch>" 形式，POST 建分支时 body 里用 "refs/heads/<branch>"
    short_ref = "heads/" + args.branch
    branch_ref = "refs/heads/" + args.branch
    existing = None
    try:
        existing = api("/repos/%s/git/ref/%s" % (REPO, short_ref), token=token)
    except urllib.error.HTTPError as e:
        if e.code != 404:
            raise
    if existing:
        cur = existing["object"]["sha"]
        print("branch exists at", cur)
        if cur != parent:
            raise SystemExit("remote branch %s != local parent %s — refusing to force-push" % (cur, parent))
    else:
        if not args.dry_run:
            api("/repos/%s/git/refs" % REPO, "POST", {"ref": branch_ref, "sha": parent}, token)
            print("branch created ->", branch_ref)

    # 1) 上传 blob —— 必须取 git 对象库里的原始字节（工作区是 CRLF，库里是 LF）
    #     用 -z 取原始路径：git 默认会把中文路径转义成八进制（core.quotepath）
    paths = [p for p in git("diff-tree", "--no-commit-id", "--name-only", "-r", "-z", head).split("\0") if p]
    if not paths:
        raise SystemExit("HEAD has no file changes")
    entries = []
    for path in paths:
        content = git("cat-file", "blob", "HEAD:" + path, binary=True)
        blob = api("/repos/%s/git/blobs" % REPO, "POST",
                   {"content": base64.b64encode(content).decode(), "encoding": "base64"}, token)
        local_blob = git("rev-parse", "HEAD:" + path).strip()
        if blob["sha"] != local_blob:
            raise SystemExit("blob mismatch for %s: api=%s local=%s" % (path, blob["sha"], local_blob))
        print("blob ok: %-30s %s (%d bytes)" % (path, blob["sha"][:10], len(content)))
        entries.append({"path": path, "mode": "100644", "type": "blob", "sha": blob["sha"]})

    # 2) 重建 tree —— 用 HEAD 的完整文件列表，确保删除的文件不会残留
    tree_entries = []
    for line in git("ls-tree", "-r", "-z", head).split("\0"):
        if not line:
            continue
        meta, path = line.split("\t", 1)
        mode, otype, sha = meta.split()
        tree_entries.append({"path": path, "mode": mode, "type": otype, "sha": sha})
    new_tree = api("/repos/%s/git/trees" % REPO, "POST",
                   {"base_tree": parent_tree, "tree": tree_entries}, token)
    print("tree api =", new_tree["sha"], " local =", tree)
    if new_tree["sha"] != tree:
        raise SystemExit("tree mismatch: api=%s local=%s" % (new_tree["sha"], tree))
    print("tree ok: %d files" % len(tree_entries))

    # 3) 创建 commit（沿用本地作者/提交者/时间/信息，SHA 应与本地一致）
    who_a = {"name": author[0], "email": author[1], "date": author[2]}
    who_c = {"name": committer[0], "email": committer[1], "date": committer[2]}
    commit = api("/repos/%s/git/commits" % REPO, "POST",
                 {"message": message + "\n", "tree": tree, "parents": [parent],
                  "author": who_a, "committer": who_c}, token)
    print("commit api =", commit["sha"], " local =", head)
    if commit["sha"] != head:
        raise SystemExit("commit mismatch: api=%s local=%s" % (commit["sha"], head))

    if args.dry_run:
        print("DRY RUN — nothing written")
        return

    # 4) 快进更新分支引用
    ref = api("/repos/%s/git/refs/%s" % (REPO, short_ref), "PATCH",
              {"sha": head, "force": False}, token)
    print("ref updated ->", ref["object"]["sha"])
    print("PUSH OK:", head)

    # 5) 创建 Pull Request
    existing_pr = api("/repos/%s/pulls?state=open&head=%s:%s" % (REPO, "TAILAI86", args.branch), token=token)
    if existing_pr:
        print("PR already exists:", existing_pr[0]["html_url"])
        return
    pr = api("/repos/%s/pulls" % REPO, "POST", {
        "title": args.title,
        "body": args.body,
        "head": args.branch,
        "base": args.base,
        "maintainer_can_modify": True,
    }, token)
    print("PR created:", pr["html_url"])
    print("PR number:", pr["number"])


if __name__ == "__main__":
    main()
