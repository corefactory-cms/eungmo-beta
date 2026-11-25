"""Publish public event additions or corrections using the operator's GitHub CLI login."""
import argparse
import base64
import json
import re
import subprocess
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit

REPO = "corefactory-cms/eungmo-beta"
ENDPOINT = "repos/" + REPO + "/contents/docs/events.json"
KST = timezone(timedelta(hours=9))
TEXT = {"title", "organizer", "prize", "entryMethod", "rules", "announcementMethod"}
DATES = {"startDate", "deadline", "drawDate", "announcementDate", "claimDeadline", "verifiedAt"}
URLS = {"sourceUrl", "entryUrl", "resultUrl", "announcementUrl"}
FIELDS = TEXT | DATES | URLS | {"id", "deadlineTime"}
OPTIONAL = {"startDate", "deadlineTime", "drawDate", "announcementDate", "resultUrl", "claimDeadline", "announcementUrl"}

def check_event(row):
    for key in FIELDS:
        value = row.get(key)
        if key in OPTIONAL and value is None:
            continue
        if not isinstance(value, str) or not value.strip() or len(value) > 1800:
            raise ValueError(f"{row['id']} / {key}: 비어 있거나 너무 긴 값")
        if key in DATES and date.fromisoformat(value).isoformat() != value:
            raise ValueError(f"{key}: YYYY-MM-DD 형식으로 입력하세요.")
        if key in URLS:
            u = urlsplit(value)
            if u.scheme != "https" or not u.hostname or u.username or u.password or any(c.isspace() for c in value):
                raise ValueError(f"{key}: 공식 HTTPS 주소가 필요합니다.")
    if row.get("deadlineTime") and not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", row["deadlineTime"]):
        raise ValueError("deadlineTime: HH:MM 형식으로 입력하세요.")
    if row.get("startDate") and row["startDate"] > row["deadline"]:
        raise ValueError("응모 시작일이 마감일 이후입니다.")

def merge(current, payload):
    if isinstance(payload, dict):
        if set(payload) - {"events", "updatedAt", "version"}:
            raise ValueError("공개 공고의 events 배열을 넣어 주세요.")
        payload = payload.get("events")
    if not isinstance(payload, list) or not payload:
        raise ValueError("올릴 공고가 없습니다.")
    rows = {e["id"]:e for e in current["events"]}
    new_ids = set()
    changes = []
    for patch in payload:
        if not isinstance(patch,dict) or not isinstance(patch.get("id"), str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,95}", patch["id"]):
            raise ValueError("id는 영문 소문자·숫자·하이픈으로 작성하세요.")
        key = patch["id"]
        if key in new_ids or set(patch) - FIELDS:
            raise ValueError(f"{key}: 중복된 ID 또는 공개 공고 양식에 없는 필드입니다.")
        new_ids.add(key)
        old = rows.get(key, {})
        row = {**dict.fromkeys(sorted(OPTIONAL)), **old, **patch}
        check_event(row)
        if old and row["verifiedAt"] < old["verifiedAt"]:
            raise ValueError(f"{key}: 현재 게시된 확인 날짜보다 오래된 자료입니다.")
        if row != old:
            changes.append(("수정" if old else "추가", row["title"]))
        rows[key] = row
    return {"version":1, "updatedAt":datetime.now(KST).isoformat(timespec="seconds"), "events":list(rows.values())}, changes

def gh(args, body=None):
    result = subprocess.run(["gh", "api", *args], input=body, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        raise RuntimeError(result.stderr.decode("utf-8", errors="replace").strip())
    return json.loads(result.stdout.decode("utf-8"))

def request_file():
    from tkinter import Tk, filedialog
    window = Tk()
    window.withdraw()
    try:
        return filedialog.askopenfilename(title="발행할 공개 공고 JSON 선택", filetypes=[("공고 JSON", "*.json")])
    finally:
        window.destroy()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("file", nargs="?")
    parser.add_argument("--yes", action="store_true", help="선택한 파일의 공개 발행을 승인합니다.")
    args = parser.parse_args()
    path = args.file or request_file()
    if not path:
        return
    payload = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    live = gh([ENDPOINT + "?ref=main"])
    current = json.loads(base64.b64decode(live["content"]).decode("utf-8-sig"))
    updated, changes = merge(current, payload)
    if not changes:
        print("모두 기존 공고와 같습니다.")
        return
    for kind, title in changes:
        print(f"{kind}  {title}")
    if not args.yes and input("공개 사이트에 발행할까요? [y/N] ").strip().lower() != "y":
        return
    binary = (json.dumps(updated, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    body = {"branch":"main", "message":f"공개 공고 {len(changes)}건 갱신", "sha":live["sha"], "content":base64.b64encode(binary).decode("ascii")}
    result = gh(["-X", "PUT", ENDPOINT, "--input", "-"], json.dumps(body).encode("utf-8"))
    print("발행 요청 완료", result["commit"]["sha"][:10])
    print("GitHub Pages 배포 후 https://corefactory-cms.github.io/eungmo-beta/ 에 반영됩니다.")

if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, RuntimeError, KeyError) as exc:
        print(f"발행하지 못했습니다. {exc}",file=sys.stderr)
        sys.exit(1)
