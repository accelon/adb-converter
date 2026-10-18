#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
accelon26 官網「留言給作者」的後端（Apache CGI，Python 3 標準庫，沒有第三方依賴）。

  POST /accelon26/message.cgi   Content-Type: application/json
  { "type": "回報錯誤", "name": "", "email": "", "wechat": "", "start": "2010",
    "message": "…", "website": "" }        # website 是 honeypot，必須是空的

回 {"ok": true}；失敗回 {"ok": false, "error": "…"}（4xx 是資料問題，5xx 是寄信問題）。

設定：/etc/accelon26-message/smtp.json（root:www-data 0640）
  { "host": "smtp.qq.com", "port": 465, "user": "3820618924@qq.com",
    "password": "QQ 信箱的授權碼", "to": "3820618924@qq.com" }

備份：/var/lib/accelon26-message/messages.jsonl（www-data 可寫；寄信失敗也留一份）
限流：/var/lib/accelon26-message/rate/<sha1(ip)>（每小時 5 則／每個 IP）
"""
import hashlib
import json
import os
import smtplib
import ssl
import sys
import time
import urllib.parse
from email.message import EmailMessage
from email.utils import formataddr, formatdate

CONF = "/etc/accelon26-message/smtp.json"
DATA = "/var/lib/accelon26-message"
LOG = os.path.join(DATA, "messages.jsonl")
RATE_DIR = os.path.join(DATA, "rate")
MAX_BODY = 32 * 1024
MAX_MESSAGE = 5000
TYPES = {"回報錯誤", "功能要求", "改良建議"}
PER_HOUR = 5


def out(status, payload):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    sys.stdout.write("Status: %d\r\n" % status)
    sys.stdout.write("Content-Type: application/json; charset=utf-8\r\n")
    sys.stdout.write("Cache-Control: no-store\r\n")
    sys.stdout.write("Content-Length: %d\r\n\r\n" % len(body))
    sys.stdout.flush()
    sys.stdout.buffer.write(body)
    sys.stdout.buffer.flush()
    raise SystemExit(0)


def field(data, name, limit):
    v = data.get(name)
    if not isinstance(v, str):
        return ""
    v = v.strip()
    return v[:limit]


def client_ip():
    env = os.environ
    # Apache 的 REMOTE_ADDR 是直連 IP；有反向代理時才看 X-Forwarded-For（我們沒有代理）
    return env.get("REMOTE_ADDR", "") or "127.0.0.1"


def rate_limited(ip):
    try:
        os.makedirs(RATE_DIR, exist_ok=True)
        key = os.path.join(RATE_DIR, hashlib.sha1(ip.encode("utf-8")).hexdigest())
        now = time.time()
        stamps = []
        if os.path.exists(key):
            with open(key, "r", encoding="utf-8") as f:
                stamps = [float(x) for x in f.read().split() if x.strip()]
        stamps = [t for t in stamps if now - t < 3600]
        if len(stamps) >= PER_HOUR:
            return True
        stamps.append(now)
        with open(key, "w", encoding="utf-8") as f:
            f.write(" ".join("%.0f" % t for t in stamps))
        return False
    except Exception:
        return False  # 限流壞掉不能擋住留言


def append_log(record):
    try:
        os.makedirs(DATA, exist_ok=True)
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception:
        pass


def load_conf():
    with open(CONF, "r", encoding="utf-8") as f:
        conf = json.load(f)
    for k in ("host", "port", "user", "password", "to"):
        if k not in conf:
            raise RuntimeError("設定缺少 " + k)
    return conf


def send_mail(conf, rec):
    subject = "[accelon26] " + (rec["type"] or "留言")
    if rec["name"]:
        subject += " — " + rec["name"]
    lines = []
    if rec["type"]:
        lines.append("類型：" + rec["type"])
    if rec["name"]:
        lines.append("稱呼：" + rec["name"])
    if rec["email"]:
        lines.append("Email：" + rec["email"])
    if rec["wechat"]:
        lines.append("微信：" + rec["wechat"])
    if rec["start"]:
        lines.append("開始使用 accelon3：" + rec["start"])
    lines.append("")
    lines.append(rec["message"])
    lines.append("")
    lines.append("—— 來自 accelon26 留言頁")
    lines.append("時間：" + rec["at"])
    lines.append("IP：" + rec["ip"])
    lines.append("瀏覽器：" + rec["ua"])

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = formataddr(("accelon26 留言", conf["user"]))
    msg["To"] = conf["to"]
    msg["Date"] = formatdate(localtime=True)
    if rec["email"]:
        msg["Reply-To"] = rec["email"]
    msg.set_content("\n".join(lines))

    ctx = ssl.create_default_context()
    with smtplib.SMTP_SSL(conf["host"], int(conf["port"]), timeout=25, context=ctx) as s:
        s.login(conf["user"], conf["password"])
        s.send_message(msg)


def main():
    method = os.environ.get("REQUEST_METHOD", "GET").upper()
    if method == "OPTIONS":
        sys.stdout.write("Status: 204\r\nAllow: GET, POST\r\n\r\n")
        return
    if method != "POST":
        # 給頁面（或人）確認後端還活著
        out(200, {"ready": True})

    try:
        length = int(os.environ.get("CONTENT_LENGTH") or 0)
    except ValueError:
        length = 0
    if length <= 0 or length > MAX_BODY:
        out(413, {"ok": False, "error": "留言太長或沒有內容（上限 32 KB）"})
    raw = sys.stdin.buffer.read(length)
    ctype = os.environ.get("CONTENT_TYPE", "")
    data = {}
    try:
        if "application/json" in ctype:
            data = json.loads(raw.decode("utf-8"))
        else:  # 沒有 JS 的退路：一般的表單編碼
            qs = urllib.parse.parse_qs(raw.decode("utf-8"), keep_blank_values=True)
            data = {k: v[0] if v else "" for k, v in qs.items()}
    except Exception:
        out(400, {"ok": False, "error": "看不懂送來的資料"})
    if not isinstance(data, dict):
        out(400, {"ok": False, "error": "看不懂送來的資料"})

    if field(data, "website", 200):
        # honeypot：機器人才會填
        out(200, {"ok": True})

    rec = {
        "type": field(data, "type", 20),
        "name": field(data, "name", 40),
        "email": field(data, "email", 120),
        "wechat": field(data, "wechat", 60),
        "start": field(data, "start", 20),
        "message": field(data, "message", MAX_MESSAGE),
        "ip": client_ip(),
        "ua": os.environ.get("HTTP_USER_AGENT", "")[:300],
        "at": time.strftime("%Y-%m-%d %H:%M:%S %z"),
    }
    if rec["type"] and rec["type"] not in TYPES:
        rec["type"] = ""  # 不認得的類型就當作沒填
    if len(rec["message"]) < 4:
        out(400, {"ok": False, "error": "留言太短了"})
    if rec["email"] and ("@" not in rec["email"] or "." not in rec["email"].split("@")[-1]):
        out(400, {"ok": False, "error": "Email 看起來不太對"})
    if rate_limited(rec["ip"]):
        out(429, {"ok": False, "error": "這個 IP 一小時內已經留了 " + str(PER_HOUR) + " 則，請稍後再試"})

    append_log(rec)
    try:
        conf = load_conf()
        send_mail(conf, rec)
    except Exception as e:  # 寄不出去也要讓使用者知道，並留下備份
        out(502, {"ok": False, "error": "留言已收到，但寄信失敗（" + type(e).__name__ + "）。可以直接寄到 3820618924@qq.com"})
    out(200, {"ok": True})


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        out(500, {"ok": False, "error": "伺服器內部錯誤（" + type(e).__name__ + "）"})
