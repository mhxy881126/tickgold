import sqlite3, json
p = r"C:\Users\Administrator\AppData\Roaming\com.stockdock.desktop\stock-dock.db"
c = sqlite3.connect(p)

print("=== strategy_profile spec 内容 ===")
for r in c.execute("SELECT key, name, spec FROM strategy_profile"):
    try:
        spec = json.loads(r[2])
        ok = isinstance(spec, dict)
        has_entry = "entry" in spec
    except Exception as e:
        ok = False; has_entry = False
    print(f"  key={r[0]} name={r[1]} spec_valid={ok} has_entry={has_entry}")

print()
print("=== theme 表数据 ===")
for r in c.execute("SELECT id, name, level, stage, logic FROM theme"):
    print(f"  id={r[0]} name={r[1]} level={r[2]} stage={r[3]} logic_len={len(r[4] or '')}")

print()
print("=== theme_stock 表结构 ===")
for r in c.execute("PRAGMA table_info(theme_stock)"):
    print(f"  {r[1]} {r[2]}")

print()
print("=== decision_log 表结构 ===")
for r in c.execute("PRAGMA table_info(decision_log)"):
    print(f"  {r[1]} {r[2]}")

print()
print("=== ai_review 表数据 sample ===")
for r in c.execute("SELECT id, trade_date, scope, subject, title FROM ai_review LIMIT 10"):
    print(f"  id={r[0]} date={r[1]} scope={r[2]} subject={r[3]} title={r[4]}")
c.close()
