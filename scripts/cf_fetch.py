import sys
import argparse
from curl_cffi import requests

def main():
    parser = argparse.ArgumentParser(description="Fetch URL impersonating Chrome to bypass Cloudflare")
    parser.add_argument("url", help="Target URL")
    parser.add_argument("--cookie", help="Cookie header string", default="")
    args = parser.parse_args()

    headers = {}
    if args.cookie:
        headers["cookie"] = args.cookie

    try:
        # Never let curl_cffi auto-follow a Location: an attacker page can
        # 302 us into cloud metadata / loopback and the Node caller has no
        # visibility into the hops. Fail closed on any 3xx instead.
        res = requests.get(
            args.url,
            headers=headers,
            impersonate="chrome120",
            timeout=30,
            allow_redirects=False
        )
        if 300 <= res.status_code < 400:
            sys.stderr.write("cf_fetch error: redirect refused (3xx not followed)\n")
            sys.exit(1)
        sys.stdout.buffer.write(res.content)
        sys.exit(0)
    except Exception as e:
        sys.stderr.write(f"cf_fetch error: {e}\n")
        sys.exit(1)

if __name__ == "__main__":
    main()
