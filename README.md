# System Monitor v2

Selbst gehostete, lokale Systemüberwachung im Browser. Aktualisiert sich live,
zeigt CPU (inkl. Per-Core), RAM, Disk-I/O, Netzwerk, GPU (NVIDIA/AMD/Intel),
Akku, Corsair-Netzteile/-AIOs (via `liquidctl`) und die wichtigsten Prozesse.

Mit **kleinen Live-Sparklines pro Kachel**, **Schwellwerten** für Warn-/
Alarm-Stufen und einem **Background-Sampler**, der Metriken kontinuierlich
mit 1 Hz im Ringpuffer hält — der Browser bekommt Snapshots damit in unter
5 ms statt erst nach einer Sekunde.

Läuft auf **Linux und Windows** (macOS ebenfalls weitgehend, ungetestet).

---

## Features

- Live-Dashboard mit Drag-&-Drop-Sortierung und Toggle pro Kachel
- Sparkline-Charts (60 letzte Samples) für CPU, RAM, Disk-I/O, Netz, GPU
- Per-Core-CPU-Auslastung als kompakter Balken-Grid
- Disk-Lese-/Schreibraten in MB/s
- Aggregierte Down-/Upload-Raten über alle aktiven Interfaces
- Schwellwerte (`warn` / `danger`) — Werte werden orange/rot, Sparklines färben sich mit
- CPU-Temperatur Cross-Platform (psutil / OpenHardwareMonitor / LibreHardwareMonitor / ACPI)
- GPU-Daten via `nvidia-smi` (Win + Linux); WMI-Fallback für Windows-iGPU
- Corsair-Netzteile (HXi/RMi), Hydro-AIOs und Commander Pro über `liquidctl`
- Admin-Oberfläche unter `/settings` mit Auth-Token-Schutz
- Plugins: eigene Kacheln per Shell-Befehl oder HTTP-Endpoint
- Theme-Persistenz (Dark/Light) via `localStorage`
- Mobile-optimiertes Layout
- Polling mit Exponential-Backoff bei Verbindungsfehlern

---

## Voraussetzungen

- **Python 3.9+**
  - Linux: `sudo apt install python3 python3-pip python3-venv`
  - Windows: <https://www.python.org> — bei der Installation
    „Add Python to PATH“ anhaken.

- **Python-Pakete** (werden vom Startskript automatisch installiert):
  - Pflicht: `psutil`, `fastapi`, `uvicorn`
  - Optional: `liquidctl` (Corsair-Netzteile/AIOs), `wmi` (AMD/Intel-iGPU
    unter Windows).

- **GPU-Temperatur (optional):**
  - NVIDIA: `nvidia-smi` im `PATH` (Standard-Treiberpaket).
  - AMD/Intel-iGPU unter Windows: `pip install wmi`.

---

## Starten

### Linux / macOS

```bash
bash start.sh           # Starten
bash start.sh stop      # Stoppen
bash start.sh restart   # Neustart
bash start.sh status    # Status
bash start.sh logs      # Logs verfolgen
```

### Windows

```bat
start.bat            :: Starten + Browser öffnen
start.bat stop       :: Stoppen
start.bat restart    :: Neustart
start.bat status     :: Status prüfen
start.bat logs       :: Logs anzeigen
```

Server lauscht standardmäßig nur lokal auf `http://127.0.0.1:10800`. Für
LAN-Zugriff vor dem Start:

```bash
export SYSMON_HOST=0.0.0.0      # Linux/macOS
set SYSMON_HOST=0.0.0.0         :: Windows
```

---

## Erste Schritte — Auth-Token setzen

Beim ersten Start ist **kein** Token gesetzt. Geschützte Endpunkte
(`/api/config`, `/api/plugins`, `/api/disks`, `/api/interfaces`) liefern
dann HTTP 503. Token in `config.json` eintragen:

```json
"auth_token": "ein-langes-zufaelliges-token"
```

Anschließend ist die Admin-Oberfläche unter `/settings` erreichbar. Dort
lässt sich das Token jederzeit ändern (Mindestlänge 6 Zeichen).

---

## REST-API

| Endpunkt              | Methode | Auth | Zweck                                              |
|-----------------------|---------|------|----------------------------------------------------|
| `/api/stats`          | GET     | nein | Aktueller Snapshot (Sampler-Cache, < 5 ms)         |
| `/api/history`        | GET     | nein | Zeitreihen für Sparklines (`?seconds=120`)         |
| `/api/system`         | GET     | nein | Statische System-Info (OS, CPU-Modell, RAM, Boot)  |
| `/api/config`         | GET     | nein | Aktuelle Konfiguration (ohne Token)                |
| `/api/config`         | POST    | ja   | Konfiguration speichern                            |
| `/api/auth`           | POST    | nein | Token prüfen                                       |
| `/api/auth/change-token` | POST | ja   | Token ändern (min. 6 Zeichen)                      |
| `/api/disks`          | GET     | ja   | Liste gemounteter Partitionen für Settings         |
| `/api/interfaces`     | GET     | ja   | Liste aktiver Netzwerk-Interfaces                  |
| `/api/plugins`        | GET/POST| ja   | Plugin-Liste lesen/speichern                       |
| `/api/plugin/{id}`    | GET     | ja   | Plugin ausführen, Ausgabe zurückgeben              |
| `/api/psu-debug`      | GET     | ja   | Roh-Output von liquidctl (Diagnose)                |

Authentifizierte Endpunkte erwarten `X-Auth-Token: <token>` im Header.

---

## Konfiguration

`config.json` enthält:

```json
{
  "title": "System Monitor",
  "refresh_ms": 3000,
  "history_seconds": 300,
  "psu_max_watts": 1000,
  "cards": [ ... ],
  "thresholds": {
    "cpu":      { "warn": 70, "danger": 90 },
    "ram":      { "warn": 75, "danger": 92 },
    "disk":     { "warn": 80, "danger": 95 },
    "cpu_temp": { "warn": 75, "danger": 90 },
    "gpu_temp": { "warn": 78, "danger": 90 }
  },
  "network_filter": [],
  "disk_filter": [],
  "plugins": [],
  "auth_token": ""
}
```

- `refresh_ms` — Browser-Polling-Intervall (min. 1000 ms, der Sampler läuft
  unabhängig mit 1 Hz).
- `history_seconds` — wie viel Historie der Backend-Ringpuffer hält.
- `thresholds` — pro Metrik die Werte, ab denen Kacheln gelb/rot werden.
- `network_filter` / `disk_filter` — leere Liste = alles anzeigen; ansonsten
  Allowlist.
- `plugins[].interval_s` — Ausführungsintervall je Plugin in Sekunden
  (Default: 15, Minimum: 1).

---

## Als Linux-systemd-Dienst

```bash
sudo useradd --system --home /opt/sysmonitor --shell /usr/sbin/nologin sysmon
sudo mkdir -p /opt/sysmonitor
sudo cp -r * /opt/sysmonitor/
sudo chown -R sysmon:sysmon /opt/sysmonitor

sudo -u sysmon python3 -m venv /opt/sysmonitor/.venv
sudo -u sysmon /opt/sysmonitor/.venv/bin/pip install psutil fastapi uvicorn liquidctl

sudo cp /opt/sysmonitor/sysmon.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now sysmon
```

Logs: `journalctl -u sysmon -f`.

---

## Als Windows-Autostart (Task Scheduler)

Kein Drittanbieter-Tool nötig — Windows Task Scheduler reicht.
CMD **als Administrator** öffnen und ausführen (Pfade anpassen):

```bat
schtasks /create /tn "SysMonitor" /tr "C:\Users\DEIN_NAME\AppData\Local\Programs\Python\Python3x\python.exe C:\Pfad\zu\system-monitor\api_server.py" /sc onstart /ru SYSTEM /rl HIGHEST /f
```

Damit startet der Server automatisch beim Windows-Start (auch ohne Anmeldung).

**Verwalten:**
```bat
schtasks /run /tn "SysMonitor"       :: manuell starten
schtasks /end /tn "SysMonitor"       :: stoppen
schtasks /delete /tn "SysMonitor" /f :: entfernen
schtasks /query /tn "SysMonitor"     :: Status prüfen
```

**Umgebungsvariablen** (z.B. für LAN-Zugriff) einmalig als Admin setzen:
```bat
setx SYSMON_HOST 0.0.0.0 /m
setx SYSMON_PORT 10800 /m
```

---

## Dateiübersicht

| Datei            | Zweck                                                |
|------------------|------------------------------------------------------|
| `api_server.py`  | FastAPI-Backend mit Sampler-Thread + Ringpuffer       |
| `config.json`    | Persistente Einstellungen, Schwellwerte, Auth-Token   |
| `index.html`     | Haupt-Dashboard                                       |
| `app.js`         | Polling, Sparkline-Rendering, Settings-Panel          |
| `style.css`      | Dark/Light-Theme + Komponenten + Mobile-Layout        |
| `settings.html`  | Admin-Oberfläche                                      |
| `settings.css`   | Styles für die Admin-Oberfläche                       |
| `settings.js`    | Admin-Logik (Login, Kacheln, Netzwerk, Plugins)       |
| `start.sh`       | Startskript Linux/macOS                               |
| `start.bat`      | Startskript Windows                                   |
| `sysmon.service` | systemd-Unit für Linux                                |

---

## Architektur-Notizen

```
┌─────────────────────┐         ┌────────────────────┐
│  Browser-Dashboard  │─poll──▶│  /api/stats        │
│  (app.js + SVG)     │         │   ↓ liest Cache    │
└─────────────────────┘         │  Sampler-Snapshot  │
                                │   ↑ 1 Hz schreibt  │
                                │  Sampler-Thread    │─reads─▶ psutil / nvidia-smi /
                                │  (Ringpuffer 300s) │         WMI / liquidctl
                                └────────────────────┘
```

- HTTP-Handler blockieren **nie** auf Sampling. Der Sampler läuft im
  Hintergrund-Thread, schreibt jeden Sample-Zyklus atomar in den Snapshot
  und füllt Ringpuffer pro Metrik.
- Plattform-Spezifika (WMI, nvidia-smi, liquidctl) sind optional und werden
  zur Laufzeit erkannt — fehlende Module/Geräte führen nicht zu Crashes.

---

## Sicherheitsempfehlungen

- Nur über HTTPS exponieren (Reverse Proxy mit TLS oder Cloudflare Tunnel).
- Kein Public-Internet-Zugriff ohne ausreichend langes Auth-Token.
- `sysmon`-User für den systemd-Dienst nutzen, nicht als root.
- Plugins führen Shell-Befehle auf dem Server aus — nur eigene anlegen und
  das Auth-Token gut schützen.

---

## Lizenz

MIT — frei zur Nutzung, Modifikation und Weitergabe.
