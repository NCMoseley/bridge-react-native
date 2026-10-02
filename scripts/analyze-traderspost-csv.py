import csv
import json
import sys
from collections import defaultdict
from urllib.parse import urlparse

def main(path):
    total = 0
    status200 = 0
    status400 = 0
    parse_failures = 0
    action_counts = defaultdict(int)
    action_status = defaultdict(lambda: defaultdict(int))
    message_counts = defaultdict(int)
    source_counts = defaultdict(int)
    ticker_counts = defaultdict(int)
    url_status = defaultdict(lambda: defaultdict(int))
    sentiment_rejections = []
    other_rejections = []
    ticker_does_not_exist = []

    with open(path, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            total += 1
            status = int(row['Status Code'])
            if status == 200:
                status200 += 1
            else:
                status400 += 1

            url = row.get('URL', '')
            url_status[url][status] += 1

            message = row.get('Message Code', '') or ''
            message_counts[message] += 1

            try:
                payload = json.loads(row['Payload'])
            except (json.JSONDecodeError, KeyError):
                parse_failures += 1
                continue

            action = payload.get('action', 'unknown')
            source = payload.get('extras', {}).get('source') or payload.get('source', 'unknown')
            ticker = payload.get('ticker', 'unknown')
            range_name = payload.get('extras', {}).get('rangeName', 'unknown')

            action_counts[action] += 1
            action_status[action][status] += 1
            source_counts[source] += 1
            ticker_counts[ticker] += 1

            if status != 200:
                rejection = {
                    'message': message,
                    'action': action,
                    'ticker': ticker,
                    'range': range_name,
                    'source': source,
                    'created_at': row.get('Created At', ''),
                    'sentiment': payload.get('sentiment'),
                    'payload': payload,
                }
                if message == 'invalid-sentiment-action':
                    sentiment_rejections.append(rejection)
                elif message == 'ticker-does-not-exist':
                    ticker_does_not_exist.append(rejection)
                else:
                    other_rejections.append(rejection)

    def sorted_items(d):
        return sorted(d.items(), key=lambda x: x[1], reverse=True)

    print('\n=== TradersPost Signal Report ===')
    print(f'Total rows: {total}')
    print(f'Status 200: {status200}')
    print(f'Status 400: {status400}')
    print(f'Success rate: {(status200 / total * 100):.1f}%')
    print(f'JSON parse failures: {parse_failures}')

    print('\n--- Status by webhook URL ---')
    for url, counts in sorted(url_status.items(), key=lambda x: x[1][200] + x[1][400], reverse=True)[:10]:
        ok = counts.get(200, 0)
        fail = counts.get(400, 0)
        print(f'{ok}/{ok + fail} {url}')

    print('\n--- Status by action ---')
    for action, count in sorted_items(action_counts):
        ok = action_status[action].get(200, 0)
        fail = action_status[action].get(400, 0)
        print(f'{action}: {count} (200: {ok}, 400: {fail})')

    print('\n--- 400 message codes ---')
    for message, count in sorted_items(message_counts):
        label = message or '(blank)'
        print(f'{label}: {count}')

    print('\n--- Sources ---')
    for source, count in sorted_items(source_counts)[:20]:
        print(f'{source}: {count}')

    print('\n--- Tickers ---')
    for ticker, count in sorted_items(ticker_counts)[:20]:
        print(f'{ticker}: {count}')

    print('\n--- invalid-sentiment-action rejections ---')
    for r in sentiment_rejections[:15]:
        print(f"  action={r['action']} sentiment={r['sentiment']} ticker={r['ticker']} range={r['range']} source={r['source']} at={r['created_at']}")

    print('\n--- ticker-does-not-exist samples ---')
    for r in ticker_does_not_exist[:15]:
        print(f"  action={r['action']} ticker={r['ticker']} range={r['range']} source={r['source']} at={r['created_at']}")

    print('\n--- Other rejection samples (first 15) ---')
    for r in other_rejections[:15]:
        label = r['message'] or '(blank)'
        print(f"  message={label} action={r['action']} ticker={r['ticker']} range={r['range']} source={r['source']} at={r['created_at']}")

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('Usage: python3 scripts/analyze-traderspost-csv.py <csv-file>')
        sys.exit(1)
    main(sys.argv[1])
