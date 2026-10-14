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
        res = requests.get(
            args.url,
            headers=headers,
            impersonate="chrome120",
            timeout=30,
            allow_redirects=True
        )
        sys.stdout.buffer.write(res.content)
        sys.exit(0)
    except Exception as e:
        sys.stderr.write(f"cf_fetch error: {e}\n")
        sys.exit(1)

if __name__ == "__main__":
    main()
