.PHONY: bump-version

bump-version:
	@export BUMP="$(or $(BUMP),patch)" VERSION="$(VERSION)"; \
	{ echo 'import json, os, re'; \
	  echo 'b=os.environ["BUMP"]; version=os.environ["VERSION"]'; \
	  echo 'if version and not re.fullmatch(r"\d+\.\d+\.\d+", version): raise SystemExit("VERSION must be X.Y.Z")'; \
	  echo 'for f in ("package.json", "opencode-plugin/package.json", "pyproject.toml", ".codex-plugin/plugin.json", ".claude-plugin/plugin.json", ".claude-plugin/marketplace.json"):'; \
	  echo '  txt=open(f).read()'; \
	  echo '  m=re.search(r"version\s*=\s*\"(\d+\.\d+\.\d+)\"", txt) if "pyproject" in f else None'; \
	  echo '  if m:'; \
	  echo '    v=[int(x) for x in m.group(1).split(".")]'; \
	  echo '  else:'; \
	  echo '    p=json.load(open(f))'; \
	  echo '    current=p["plugins"][0]["version"] if "marketplace" in f else p["version"]'; \
	  echo '    v=[int(x) for x in current.split(".")]'; \
	  echo '  if version: v=[int(x) for x in version.split(".")]'; \
	  echo '  elif b=="major": v=[v[0]+1,0,0]'; \
	  echo '  elif b=="minor": v=[v[0],v[1]+1,0]'; \
	  echo '  else: v[2]+=1'; \
	  echo '  nv=".".join(map(str,v))'; \
	  echo '  if "pyproject" in f:'; \
	  echo '    open(f,"w").write(re.sub(r"(version\s*=\s*\")\d+\.\d+\.\d+(\")", r"\g<1>"+nv+r"\g<2>", txt))'; \
	  echo '  else:'; \
	  echo '    (p["plugins"][0] if "marketplace" in f else p)["version"]=nv'; \
	  echo '    json.dump(p,open(f,"w"),indent=2)'; \
	  echo '    open(f,"a").write(chr(10))'; \
	  echo '  print(f"{f}: {nv}")'; \
	} | python3 && npm install --package-lock-only --silent
