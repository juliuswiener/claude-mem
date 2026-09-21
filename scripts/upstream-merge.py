#!/usr/bin/env python3
"""Upstream in einen Subtraktions-Fork holen, ohne das Entfernte stillschweigend
zurueckzuholen oder stillschweigend zu verlieren.

    scripts/upstream-merge.py report   [ours] [theirs]
    scripts/upstream-merge.py resolve

Dieser Fork entfernt ganze Bereiche (Viewer, npx-cli, Server, Skills, Modes,
Cloud-Sync, Cursor/Codex). Jede Verschmelzung erzeugt deshalb dieselbe Sorte
Konflikt: upstream hat eine Datei geaendert, die es hier nicht mehr gibt. Die
Antwort lautet fast immer "bleibt geloescht" -- und "fast immer" ist der Grund,
warum hier nichts ohne Protokoll passiert.

DIE GRENZE DIESES WERKZEUGS, ausdruecklich:
  Es entscheidet NUR ueber Pfade, die dieser Fork selbst entfernt hat. Konflikte
  im behaltenen Kern fasst es nicht an -- die sind Handarbeit, und es sagt, welche.
  Es beweist auch nichts ueber Bedeutung: ein Konflikt weniger heisst nicht, dass
  der Baum uebersetzt. Das Urteil sind `tsc --noEmit` und `bun test` NACH der
  Verschmelzung, nicht die Konfliktzahl davor.

`report` laeuft vor der Verschmelzung und liest nur. `resolve` laeuft waehrend
einer konfliktbehafteten Verschmelzung und loest ausschliesslich das geloeschte
Gebiet auf -- und verweigert das, wenn der behaltene Kern noch etwas davon
importiert.
"""
import collections
import os
import re
import subprocess
import sys

CODE = (".ts", ".tsx", ".js", ".cjs", ".mjs")
# Gebaute Buendel sind keine Zeugen: sie enthalten den alten Text einkompiliert
# und werden ohnehin neu erzeugt. Ein Treffer dort beweist nichts.
BUILT = ("plugin/scripts/", "plugin/ui/", "plugin/sqlite/", "dist/")
SPEC = re.compile(r"""(?:\bfrom|\bimport|\brequire\s*\()\s*['"]([^'"]+)['"]""")


def git(*args, check=True):
    p = subprocess.run(["git", *args], capture_output=True, text=True)
    if check and p.returncode:
        sys.exit(f"git {' '.join(args)} scheiterte:\n{p.stderr.strip()}")
    return p.stdout


def deleted_by_us(base, ours):
    return {ln.split("\t", 1)[1].strip()
            for ln in git("diff", "--name-status", f"{base}..{ours}").splitlines()
            if ln.startswith("D\t")}


def broken_imports(gone):
    """Importiert der BEHALTENE Baum noch einen entfernten Pfad?

    Aufgeloest, nicht geraten. Der erste Entwurf suchte den Dateistamm im Text und
    meldete "SKILL.md wird erwaehnt in worker-service.cjs" -- ein Treffer auf das
    Wort "SKILL". Nur ein Importpfad, der auf eine entfernte Datei zeigt, bricht
    wirklich etwas.
    """
    hits = []
    for kp in git("ls-files").splitlines():
        if not kp.endswith(CODE) or kp.startswith(BUILT) or kp in gone:
            continue
        try:
            with open(kp, encoding="utf-8", errors="ignore") as fh:
                text = fh.read()
        except OSError:
            continue
        for spec in SPEC.findall(text):
            if not spec.startswith("."):
                continue                      # Paketname, kein Pfad in diesem Baum
            t = os.path.normpath(os.path.join(os.path.dirname(kp), spec))
            stem = t[:-3] if t.endswith(".js") else t
            for cand in (t, *(stem + e for e in CODE),
                         *(f"{stem}/index{e}" for e in CODE)):
                if cand in gone:
                    hits.append((kp, spec, cand))
                    break
    return hits


def cmd_report(ours="HEAD", theirs="upstream/main"):
    base = git("merge-base", ours, theirs).strip()
    gone = deleted_by_us(base, ours)
    touched = {}
    for ln in git("diff", "--name-status", f"{base}..{theirs}").splitlines():
        parts = ln.split("\t")
        if len(parts) >= 2:
            touched[parts[-1].strip()] = parts[0][0]
    overlap = sorted(p for p in gone if p in touched)

    print(f"gemeinsamer Vorfahr          : {base[:12]}")
    print(f"von diesem Fork entfernt     : {len(gone)} Dateien")
    print(f"davon von upstream veraendert: {len(overlap)}")
    if not overlap:
        print("\nNichts zu entscheiden.")
        return 0

    groups = collections.defaultdict(list)
    for p in overlap:
        seg = p.split("/")
        groups["/".join(seg[:2]) if len(seg) > 1 else seg[0]].append(p)
    print("\nGeloeschtes Gebiet, das upstream angefasst hat:")
    for area in sorted(groups):
        kinds = collections.Counter(touched[p] for p in groups[area])
        kindtxt = " ".join(f"{k}:{v}" for k, v in sorted(kinds.items()))
        print(f"  {area:40s} {len(groups[area]):3d}  [{kindtxt}]")

    subjects = git("log", "--format=%s", f"{base}..{theirs}", "--", *overlap).splitlines()
    print(f"\n{len(subjects)} upstream-Commits arbeiten dort. Die juengsten:")
    for s in subjects[:10]:
        print(f"  - {s[:92]}")
    if len(subjects) > 10:
        print(f"  ... und {len(subjects) - 10} weitere")

    hits = broken_imports(gone)
    print()
    if hits:
        print(f"ACHTUNG: {len(hits)} Import(e) aus dem behaltenen Kern zeigen ins Entfernte.")
        for kp, spec, cand in hits[:20]:
            print(f"  {kp}  ->  {spec}   ({cand})")
        print("\nUrteil: NICHT automatisch aufloesbar -- das waere ein Bruch, kein Wegfall.")
        return 1
    print("Kein Import aus dem behaltenen Kern zeigt ins Entfernte.")
    print("Urteil: das geloeschte Gebiet ist automatisch aufloesbar ('bleibt geloescht').")
    return 0


def merge_gone():
    gitdir = git("rev-parse", "--git-dir").strip()
    if not os.path.exists(os.path.join(gitdir, "MERGE_HEAD")):
        sys.exit("Keine Verschmelzung im Gang. Erst `git merge upstream/main`.")
    return deleted_by_us(git("merge-base", "HEAD", "MERGE_HEAD").strip(), "HEAD")


def cmd_resolve():
    gone = merge_gone()
    unmerged = sorted({ln.strip()
                       for ln in git("diff", "--name-only", "--diff-filter=U").splitlines()
                       if ln.strip()})
    stays = [p for p in unmerged if p in gone]
    rest = [p for p in unmerged if p not in gone]
    for p in stays:
        git("rm", "--quiet", "--force", "--", p)
    print(f"aufgeloest als 'bleibt geloescht': {len(stays)}")

    built = [p for p in rest if p.startswith(BUILT)]
    hand = [p for p in rest if not p.startswith(BUILT)]
    print(f"neu zu bauen statt verschmelzen : {len(built)}")
    for p in built:
        print(f"    {p}")
    print(f"HANDARBEIT                      : {len(hand)}")
    for p in hand:
        print(f"    {p}")

    orphans = broken_imports(gone)
    print(f"\nWaisen (importieren ins Entfernte): {len(orphans)} Verweis(e) "
          f"aus {len({o[0] for o in orphans})} Datei(en)")
    for kp, spec, _ in orphans:
        print(f"    {kp}  ->  {spec}")
    if orphans:
        print("\nDas sind Dateien, die upstream seither in einem subtrahierten Feature "
              "gebaut hat.\nSie erzeugen KEINEN Konflikt -- sie kommen einfach mit. "
              "`subtract` entfernt sie.")
    print("\nUrteil faellt danach nicht hier, sondern in tsc --noEmit und bun test.")
    return 0


def cmd_subtract():
    """Die Subtraktion auf das nachziehen, was upstream seither dazugebaut hat.

    Ein Konflikt ist sichtbar, eine Hinzufuegung nicht: upstream legt neue Dateien
    in einem Feature an, das dieser Fork entfernt hat, und die Verschmelzung nimmt
    sie widerspruchslos auf. Erst ihr Import ins Leere verraet sie.

    Fixpunkt, weil das Entfernen neue Waisen erzeugen kann: wer nur den Installer
    importierte, ist nach dessen Entfernung selbst verwaist.

    ZWEI BOEDEN, und der erste Entwurf hatte keinen davon -- er frass sich vom
    Konflikt in `src/services/worker-service.ts` durch bis zu allen Providern und
    Routen, also in das Herz dessen, was dieser Fork behalten will:

      1. Entfernt wird NUR, was die Verschmelzung neu hereingebracht hat. Eine
         Datei, die schon in unserem HEAD stand, ist per Definition Kern. Zeigt
         ihr Import ins Leere, ist das eine Reparatur, keine Loeschung.
      2. Konfliktbehaftete Dateien bleiben unangetastet. Ihr Inhalt auf der Platte
         ist Konfliktmarkierung plus beide Seiten, also kein Zeugnis darueber, was
         sie am Ende importieren.
    """
    gone = set(merge_gone())
    ours = set(git("ls-tree", "-r", "--name-only", "HEAD").splitlines())
    unmerged = {ln.strip() for ln in
                git("diff", "--name-only", "--diff-filter=U").splitlines() if ln.strip()}

    removed, blocked, rounds = [], [], 0
    while rounds <= 10:
        orphans = broken_imports(gone)
        victims, held = [], []
        for kp in sorted({o[0] for o in orphans}):
            (held if (kp in ours or kp in unmerged) else victims).append(kp)
        blocked = held
        if not victims:
            break
        rounds += 1
        for p in victims:
            git("rm", "--quiet", "--force", "--", p)
            gone.add(p)
            removed.append((rounds, p))
    else:
        sys.exit("Mehr als 10 Runden -- das sieht nach einem Zyklus aus, nicht nach Waisen.")

    print(f"nachsubtrahiert in {rounds} Runde(n): {len(removed)} Datei(en) — "
          f"alle neu von upstream, keine aus unserem HEAD")
    for r, p in removed:
        print(f"  [{r}] {p}")
    if blocked:
        print(f"\nNICHT angefasst, {len(blocked)} Datei(en) aus Kern oder Konflikt — "
              f"das ist Reparatur, keine Subtraktion:")
        for p in blocked:
            print(f"    {p}{'  (Konflikt)' if p in unmerged else ''}")
    print("\nJetzt die Handarbeit, dann bauen, dann tsc und bun test.")
    return 0


if __name__ == "__main__":
    verb = sys.argv[1] if len(sys.argv) > 1 else "report"
    if verb == "report":
        sys.exit(cmd_report(*sys.argv[2:]))
    if verb == "resolve":
        sys.exit(cmd_resolve())
    if verb == "subtract":
        sys.exit(cmd_subtract())
    sys.exit(__doc__)
