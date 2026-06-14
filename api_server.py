#!/usr/bin/env python3
"""
System Monitor — FastAPI-Backend.

Architektur
-----------
* Ein **Sampler-Thread** sammelt sekündlich Metriken (CPU, RAM, Disk-I/O,
  Netzwerk, GPU, Temperaturen, liquidctl-Daten, Prozesse) und schreibt sie
  in Ringpuffer.
* HTTP-Handler antworten direkt aus dem Cache — keine ``time.sleep`` mehr
  im Request-Pfad. Latenz von ~1 s pro ``/api/stats``-Aufruf auf < 5 ms.
* ``/api/history`` liefert Zeitreihen für Sparklines im Frontend.
* Plattform-Spezifika (NVIDIA, WMI, liquidctl) sind optional und schlucken
  Fehler still, damit das Tool auch ohne sie läuft.

Cross-Platform
--------------
Läuft auf Linux und Windows. Plattform-spezifischer Code ist hinter
``IS_WINDOWS`` / ``IS_LINUX`` versteckt, optionale Imports laufen über
``try/except``.
"""

from __future__ import annotations

import collections
import json
import math
import os
import platform
import socket
import subprocess
import sys
import threading
import time
from typing import Any, Dict, List, Optional

import psutil
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

# ── Plattform-Konstanten ───────────────────────────────────────────────────
IS_WINDOWS = sys.platform == "win32"
IS_LINUX = sys.platform.startswith("linux")
IS_MACOS = sys.platform == "darwin"

# `subprocess.CREATE_NO_WINDOW` existiert nur auf Windows.
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0) if IS_WINDOWS else 0

_HERE = os.path.dirname(os.path.abspath(__file__))
_CONFIG_FILE = os.path.join(_HERE, "config.json")

# Default-Schwellwerte: Werte >= warn werden orange, >= danger rot.
DEFAULT_THRESHOLDS = {
    "cpu":      {"warn": 70, "danger": 90},
    "ram":      {"warn": 75, "danger": 92},
    "disk":     {"warn": 80, "danger": 95},
    "cpu_temp": {"warn": 75, "danger": 90},
    "gpu_temp": {"warn": 78, "danger": 90},
}

# Wie viele Sekunden Historie der Ringpuffer hält.
HISTORY_SECONDS_DEFAULT = 300  # 5 Minuten
SAMPLE_INTERVAL_S = 1.0        # 1 Hz Sampling

# liquidctl pollt USB-Devices (Corsair PSU, AIO, Commander). Das kollidiert mit
# iCUE / Corsair-Software, die auf die gleichen Devices zugreift. Wenn der
# Sampler zu häufig pollt, verliert iCUE die Verbindung → Lüfter fallen auf
# Default-Kurve. Wir cachen das Ergebnis und pollen viel seltener als die
# anderen Metriken. PSU ist meist unkritisch, AIO ist der Hauptkonfliktpunkt
# (iCUE regelt AIO-Lüfter aktiv), daher separater, längerer Default-Intervall.
LIQUIDCTL_PSU_INTERVAL_S_DEFAULT = 30.0
LIQUIDCTL_AIO_INTERVAL_S_DEFAULT = 120.0
LIQUIDCTL_INTERVAL_S_DEFAULT = LIQUIDCTL_PSU_INTERVAL_S_DEFAULT  # backwards-compat
PLUGIN_INTERVAL_S_DEFAULT = 15.0
PLUGIN_INTERVAL_S_MIN = 1.0


# ── Config ─────────────────────────────────────────────────────────────────
_config_lock = threading.Lock()


def _plugin_interval_s(plugin: Dict[str, Any]) -> float:
    raw = plugin.get("interval_s", PLUGIN_INTERVAL_S_DEFAULT)
    try:
        interval = float(raw)
    except (TypeError, ValueError):
        interval = PLUGIN_INTERVAL_S_DEFAULT
    if not math.isfinite(interval):
        interval = PLUGIN_INTERVAL_S_DEFAULT
    return max(interval, PLUGIN_INTERVAL_S_MIN)


def _normalise_plugins(plugins: Any) -> List[Dict[str, Any]]:
    if not isinstance(plugins, list):
        return []

    result: List[Dict[str, Any]] = []
    for plugin in plugins:
        if not isinstance(plugin, dict):
            continue
        item = dict(plugin)
        item["interval_s"] = _plugin_interval_s(item)
        result.append(item)
    return result


def _config_defaults() -> Dict[str, Any]:
    return {
        "title": "System Monitor",
        "refresh_ms": 3000,
        "auth_token": "",
        "cards": [],
        # Dashboard-Layout aus dem Edit-Modus (Größe/Reihenfolge/Sichtbarkeit
        # der Kacheln). Wird vom Frontend befüllt; leer = Defaults aus "cards".
        "layout": [],
        "network_filter": [],
        "disk_filter": [],
        "plugins": [],
        "thresholds": DEFAULT_THRESHOLDS,
        "history_seconds": HISTORY_SECONDS_DEFAULT,
        "psu_max_watts": 1000,
        # liquidctl konfliktiert mit iCUE/Corsair-Software.
        # PSU ist meist unkritisch (iCUE regelt da nichts aktiv) → default on.
        # AIO ist der Hauptkonflikt (iCUE steuert die Lüfter aktiv) → default off.
        # Wenn AIO an ist, wird sehr selten gepollt (120 s), damit iCUE in den
        # Pausen die volle Kontrolle hat. Bei Bedarf in der config.json bzw.
        # über /settings tunen.
        "enable_liquidctl_psu": True,
        "enable_liquidctl_aio": False,
        "liquidctl_psu_interval_s": LIQUIDCTL_PSU_INTERVAL_S_DEFAULT,
        "liquidctl_aio_interval_s": LIQUIDCTL_AIO_INTERVAL_S_DEFAULT,
    }


def _load_config() -> Dict[str, Any]:
    with _config_lock:
        defaults = _config_defaults()
        try:
            with open(_CONFIG_FILE, "r", encoding="utf-8") as f:
                user = json.load(f)
        except FileNotFoundError:
            return defaults
        except Exception:
            return defaults
        # Fehlende Default-Schlüssel auffüllen (Migration).
        for key, val in defaults.items():
            user.setdefault(key, val)
        # Schwellwerte sanft mergen
        merged = dict(DEFAULT_THRESHOLDS)
        for k, v in (user.get("thresholds") or {}).items():
            if isinstance(v, dict):
                merged[k] = {**merged.get(k, {}), **v}
        user["thresholds"] = merged
        user["plugins"] = _normalise_plugins(user.get("plugins"))
        return user


def _save_config(data: Dict[str, Any]) -> None:
    with _config_lock:
        tmp = _CONFIG_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.replace(tmp, _CONFIG_FILE)


def _check_auth(request: Request) -> None:
    cfg = _load_config()
    token = cfg.get("auth_token", "")
    if not token:
        # Bewusst geschlossen — kein offener Modus.
        raise HTTPException(
            status_code=503,
            detail="Kein Auth-Token gesetzt. Bitte config.json -> auth_token befüllen.",
        )
    auth = request.headers.get("X-Auth-Token", "")
    if auth != token:
        raise HTTPException(status_code=401, detail="Unauthorized")


# ── Hilfsfunktionen ────────────────────────────────────────────────────────
def bytes_to_gb(b: float) -> float:
    return round(b / (1024 ** 3), 2)


def bytes_to_mb(b: float) -> float:
    return round(b / (1024 ** 2), 2)


def uptime_str() -> str:
    try:
        secs = int(time.time() - psutil.boot_time())
        d, rem = divmod(secs, 86400)
        h, rem = divmod(rem, 3600)
        m, s = divmod(rem, 60)
        if d > 0:
            return f"{d}d {h:02d}h {m:02d}m"
        return f"{h}h {m:02d}m {s:02d}s"
    except Exception:
        return "—"


def _classify(value: Optional[float], thresholds: Dict[str, float]) -> str:
    """Gibt 'ok'/'warn'/'danger' anhand der Schwellwerte zurück."""
    if value is None:
        return "ok"
    if value >= thresholds.get("danger", 1e9):
        return "danger"
    if value >= thresholds.get("warn", 1e9):
        return "warn"
    return "ok"


# ── Plattform-spezifische Detektoren ──────────────────────────────────────
def _detect_cpu_model() -> str:
    """Liefert einen menschlich lesbaren CPU-Namen (cross-platform)."""
    # 1) /proc/cpuinfo unter Linux
    if IS_LINUX:
        try:
            with open("/proc/cpuinfo", "r") as f:
                for line in f:
                    if line.lower().startswith("model name"):
                        return line.split(":", 1)[1].strip()
        except Exception:
            pass
    # 2) WMI unter Windows (psutil.processor() gibt dort nur die Architektur)
    if IS_WINDOWS:
        try:
            import wmi  # type: ignore
            w = wmi.WMI()
            for cpu in w.Win32_Processor():
                name = (cpu.Name or "").strip()
                if name:
                    return name
        except Exception:
            pass
    # 3) Fallback: platform.processor()
    name = platform.processor() or ""
    return name.strip() or "Unknown CPU"


def _read_cpu_temp() -> Optional[float]:
    """Versucht, eine CPU-Temperatur in °C zu lesen. Plattform-spezifisch."""
    if IS_LINUX or IS_MACOS:
        try:
            temps = psutil.sensors_temperatures()
        except Exception:
            return None
        # Bekannte Sensor-Namen in absteigender Priorität durchprobieren.
        for key in ("coretemp", "k10temp", "zenpower", "cpu_thermal",
                    "acpitz", "applesmc"):
            entries = temps.get(key) or []
            if entries:
                try:
                    return round(float(entries[0].current), 1)
                except Exception:
                    continue
        return None
    if IS_WINDOWS:
        # Versuch 1: OpenHardwareMonitor / LibreHardwareMonitor (falls läuft).
        try:
            import wmi  # type: ignore
            for ns in ("root\\OpenHardwareMonitor", "root\\LibreHardwareMonitor"):
                try:
                    w = wmi.WMI(namespace=ns)
                    sensors = [s for s in w.Sensor() if s.SensorType == "Temperature"
                               and ("CPU" in (s.Name or "") or "Package" in (s.Name or ""))]
                    if sensors:
                        return round(float(sensors[0].Value), 1)
                except Exception:
                    continue
        except Exception:
            pass
        # Versuch 2: ACPI Thermal Zone (oft ungenau, aber überall vorhanden)
        try:
            import wmi  # type: ignore
            w = wmi.WMI(namespace="root\\wmi")
            sensors = w.MSAcpi_ThermalZoneTemperature()
            if sensors:
                # Wert ist in Decikelvin (1/10 K).
                return round(sensors[0].CurrentTemperature / 10.0 - 273.15, 1)
        except Exception:
            pass
    return None


def _query_nvidia_smi() -> Optional[Dict[str, Any]]:
    """Liest GPU-Daten via nvidia-smi (Windows + Linux). Liefert None ohne Karte."""
    cmd = "nvidia-smi.exe" if IS_WINDOWS else "nvidia-smi"
    try:
        result = subprocess.run(
            [cmd,
             "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=3,
            creationflags=NO_WINDOW,
        )
    except (FileNotFoundError, subprocess.SubprocessError):
        return None
    if result.returncode != 0 or not result.stdout.strip():
        return None
    try:
        parts = [x.strip() for x in result.stdout.strip().splitlines()[0].split(",")]
        return {
            "name": parts[0],
            "load": float(parts[1]),
            "mem_used_gb": round(float(parts[2]) / 1024, 2),
            "mem_total_gb": round(float(parts[3]) / 1024, 2),
            "temp": float(parts[4]),
            "power": float(parts[5]) if parts[5] not in ("", "[N/A]") else None,
        }
    except (ValueError, IndexError):
        return None


def _query_wmi_gpu() -> Optional[Dict[str, Any]]:
    """Sucht GPUs via WMI auf Windows. Liefert nur Name + Gesamt-VRAM."""
    if not IS_WINDOWS:
        return None
    try:
        import wmi  # type: ignore
        w = wmi.WMI()
        for g in w.Win32_VideoController():
            name = (g.Name or "").strip()
            if not name:
                continue
            mem_total = None
            ram = getattr(g, "AdapterRAM", None)
            if ram:
                try:
                    mem_total = round(int(ram) / (1024 ** 3), 2)
                except Exception:
                    pass
            return {"name": name, "load": None, "mem_used_gb": None,
                    "mem_total_gb": mem_total, "temp": None, "power": None}
    except Exception:
        return None
    return None


def _query_liquidctl(
    want_psu: bool = True,
    want_aio: bool = True,
    want_commander: bool = True,
) -> Dict[str, Optional[Dict[str, Any]]]:
    """Sammelt Daten von Corsair-PSU, AIO und Commander Pro via liquidctl.

    Achtung: Das öffnet USB-Devices, die auch iCUE/Corsair-Software nutzt.
    Wird vom Sampler nur alle paar Sekunden aufgerufen (siehe
    ``liquidctl_interval_s`` in der Config). Mit den ``want_*``-Flags können
    Gerätetypen übersprungen werden, um iCUE-Kollisionen zu minimieren
    (besonders relevant für AIOs, die iCUE aktiv regelt).
    """
    result: Dict[str, Optional[Dict[str, Any]]] = {
        "psu": None, "aio": None, "commander": None,
    }
    try:
        from liquidctl import find_liquidctl_devices  # type: ignore
    except Exception:
        return result

    def status_to_dict(dev) -> Dict[str, Any]:
        out: Dict[str, Any] = {}
        try:
            for entry in dev.get_status():
                if len(entry) >= 2:
                    out[str(entry[0])] = entry[1]
        except Exception:
            pass
        return out

    try:
        devices = list(find_liquidctl_devices())
    except Exception:
        return result

    for dev in devices:
        desc = getattr(dev, "description", "") or ""
        is_psu = "HX" in desc or "RM" in desc
        is_aio = any(tag in desc for tag in ("Hydro", "H115", "H100", "H150", "iCUE"))
        is_commander = "Commander" in desc
        # Überspringen, wenn wir den Devicetyp nicht haben wollen (verhindert
        # unnötige USB-Open/Close-Zyklen, die iCUE stören).
        if is_psu and not want_psu:
            continue
        if is_aio and not want_aio:
            continue
        if is_commander and not want_commander:
            continue
        try:
            with dev.connect():
                try:
                    dev.initialize()
                except Exception:
                    pass
                s = status_to_dict(dev)

                if is_psu:
                    result["psu"] = {
                        "name": desc,
                        "total_w": s.get("Total power output"),
                        "input_w": s.get("Estimated input power"),
                        "efficiency": s.get("Estimated efficiency"),
                        "input_v": s.get("Input voltage"),
                        "12v_v": s.get("+12V output voltage"),
                        "12v_a": s.get("+12V output current"),
                        "12v_w": s.get("+12V output power"),
                        "5v_v": s.get("+5V output voltage"),
                        "5v_a": s.get("+5V output current"),
                        "5v_w": s.get("+5V output power"),
                        "33v_v": s.get("+3.3V output voltage"),
                        "33v_a": s.get("+3.3V output current"),
                        "33v_w": s.get("+3.3V output power"),
                        "temp_vrm": s.get("VRM temperature"),
                        "temp_case": s.get("Case temperature"),
                        "fan_rpm": s.get("Fan speed"),
                        "fan_mode": s.get("Fan control mode"),
                        "uptime_s": s.get("Current uptime"),
                    }
                elif is_aio:
                    result["aio"] = {
                        "name": desc,
                        "liquid_temp": s.get("Liquid temperature"),
                        "fan1_rpm": s.get("Fan 1 speed"),
                        "fan1_duty": s.get("Fan 1 duty"),
                        "fan2_rpm": s.get("Fan 2 speed"),
                        "fan2_duty": s.get("Fan 2 duty"),
                        "pump_rpm": s.get("Pump speed"),
                        "pump_duty": s.get("Pump duty"),
                    }
                elif is_commander:
                    result["commander"] = {
                        "name": desc,
                        "fan1": s.get("Fan 1 speed"),
                        "fan2": s.get("Fan 2 speed"),
                        "fan3": s.get("Fan 3 speed"),
                        "12v": s.get("+12V rail"),
                        "5v": s.get("+5V rail"),
                        "33v": s.get("+3.3V rail"),
                    }
        except Exception:
            continue
    return result


# ── Sampler-Thread ────────────────────────────────────────────────────────
class Sampler:
    """
    Sammelt sekündlich Metriken und hält die letzten N Sekunden im Ringpuffer.

    Thread-safe via Lock — Reader bekommen jeweils einen Snapshot.
    """

    def __init__(self, history_seconds: int = HISTORY_SECONDS_DEFAULT) -> None:
        self._lock = threading.Lock()
        self.history_seconds = history_seconds
        cap = max(history_seconds, 30)
        # Pro Metrik ein Deque mit (timestamp, value).
        self._history: Dict[str, collections.deque] = {
            k: collections.deque(maxlen=cap) for k in
            ("cpu", "ram", "disk_read", "disk_write", "net_dl", "net_ul",
             "cpu_temp", "gpu_load", "gpu_temp")
        }
        self._snapshot: Dict[str, Any] = {}
        self._prev_disk_io: Optional[psutil._common.sdiskio] = None
        self._prev_net_io: Optional[psutil._common.snetio] = None
        self._prev_net_per_nic: Dict[str, Any] = {}
        self._prev_t: Optional[float] = None

        # CPU-Modell ist statisch — einmal cachen.
        self._cpu_model = _detect_cpu_model()

        # `cpu_percent(None)` muss einmal initial aufgerufen werden,
        # damit der nächste Aufruf einen sinnvollen Wert liefert.
        psutil.cpu_percent(interval=None)
        for p in psutil.process_iter(["pid"]):
            try:
                p.cpu_percent(interval=None)
            except Exception:
                pass

        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True, name="sysmon-sampler")

        # liquidctl-Cache: PSU und AIO getrennt mit eigenem Timestamp.
        # Wird nur alle ``liquidctl_*_interval_s`` Sekunden aktualisiert, damit
        # iCUE die USB-Devices nicht ständig verliert.
        self._lc_cache: Dict[str, Any] = {
            "psu": None, "aio": None, "commander": None,
        }
        self._lc_psu_last_t: float = 0.0
        self._lc_aio_last_t: float = 0.0

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _run(self) -> None:
        while not self._stop.wait(SAMPLE_INTERVAL_S):
            try:
                self._sample_once()
            except Exception:
                # Sampler darf niemals sterben — Fehler nur loggen wäre nett,
                # aber wir bleiben silent, um die Konsole sauber zu halten.
                pass

    def _sample_once(self) -> None:
        now = time.time()
        cfg = _load_config()
        disk_filter = cfg.get("disk_filter") or []
        net_filter = cfg.get("network_filter") or []
        thresholds = cfg.get("thresholds", DEFAULT_THRESHOLDS)

        # CPU
        cpu_total = psutil.cpu_percent(interval=None)
        cpu_per_core = psutil.cpu_percent(interval=None, percpu=True)
        try:
            cpu_freq = psutil.cpu_freq()
            freq_ghz = round(cpu_freq.current / 1000, 2) if cpu_freq else None
        except Exception:
            freq_ghz = None

        # RAM
        mem = psutil.virtual_memory()
        try:
            swap = psutil.swap_memory()
            swap_pct = swap.percent
            swap_used_gb = bytes_to_gb(swap.used)
            swap_total_gb = bytes_to_gb(swap.total)
        except Exception:
            swap_pct = 0.0
            swap_used_gb = swap_total_gb = 0.0

        # Disks (Speicherplatz pro Mountpoint)
        disks: List[Dict[str, Any]] = []
        seen_mp: set = set()
        try:
            for p in psutil.disk_partitions(all=False):
                mp = p.mountpoint
                if mp in seen_mp:
                    continue
                seen_mp.add(mp)
                # Auf Windows liefern manche Laufwerke (z.B. CD-ROM) keinen Usage.
                try:
                    u = psutil.disk_usage(mp)
                except Exception:
                    continue
                label = p.device.rstrip("\\") if IS_WINDOWS else mp
                disks.append({
                    "mountpoint": mp,
                    "label": label,
                    "device": p.device,
                    "fstype": p.fstype,
                    "total_gb": bytes_to_gb(u.total),
                    "used_gb": bytes_to_gb(u.used),
                    "free_gb": bytes_to_gb(u.free),
                    "percent": u.percent,
                })
        except Exception:
            pass

        all_disks = list(disks)
        if disk_filter:
            disks = [d for d in disks if d["mountpoint"] in disk_filter]

        # Disk-I/O (aggregiert)
        try:
            io = psutil.disk_io_counters()
        except Exception:
            io = None
        disk_read_mbps = disk_write_mbps = 0.0
        if io and self._prev_disk_io and self._prev_t:
            dt = max(now - self._prev_t, 1e-3)
            disk_read_mbps = max(io.read_bytes - self._prev_disk_io.read_bytes, 0) / dt / (1024 ** 2)
            disk_write_mbps = max(io.write_bytes - self._prev_disk_io.write_bytes, 0) / dt / (1024 ** 2)
        if io:
            self._prev_disk_io = io

        # Netzwerk
        try:
            net_addrs = psutil.net_if_addrs()
            net_stats = psutil.net_if_stats()
            per_nic = psutil.net_io_counters(pernic=True)
            tot_net = psutil.net_io_counters()
        except Exception:
            net_addrs, net_stats, per_nic, tot_net = {}, {}, {}, None

        prio_order = ("Ethernet", "Wi-Fi", "eth", "en", "wlan") if IS_WINDOWS \
            else ("eth", "en", "wlan", "Wi-Fi", "Ethernet")
        candidates = []
        for iface, addrs in net_addrs.items():
            try:
                st = net_stats.get(iface)
                if st and not st.isup:
                    continue
                ip = next((a.address for a in addrs
                           if a.family == socket.AF_INET
                           and not a.address.startswith("127.")
                           and not a.address.startswith("169.254.")), None)
                if not ip:
                    continue
                prio = next((i for i, p in enumerate(prio_order) if iface.startswith(p)), 99)
                candidates.append((prio, iface, ip))
            except Exception:
                continue
        candidates.sort()

        if net_filter:
            candidates = [c for c in candidates if c[1] in net_filter]

        interfaces: List[Dict[str, Any]] = []
        for _, iface, ip in candidates:
            c = per_nic.get(iface)
            p = self._prev_net_per_nic.get(iface)
            if c and p and self._prev_t:
                dt = max(now - self._prev_t, 1e-3)
                dl_kbps = max(c.bytes_recv - p.bytes_recv, 0) / dt / 1024
                ul_kbps = max(c.bytes_sent - p.bytes_sent, 0) / dt / 1024
            else:
                dl_kbps = ul_kbps = 0.0
            interfaces.append({
                "name": iface,
                "ip": ip,
                "dl_kbps": round(dl_kbps, 1),
                "ul_kbps": round(ul_kbps, 1),
                "sent_gb": bytes_to_gb(c.bytes_sent) if c else 0.0,
                "recv_gb": bytes_to_gb(c.bytes_recv) if c else 0.0,
            })
        self._prev_net_per_nic = dict(per_nic)

        # Aggregierte Netzwerk-Rate für History-Chart
        net_dl_kbps_total = sum(i["dl_kbps"] for i in interfaces)
        net_ul_kbps_total = sum(i["ul_kbps"] for i in interfaces)

        # GPU
        gpu = _query_nvidia_smi() or _query_wmi_gpu()

        # CPU-Temperatur
        cpu_temp = _read_cpu_temp()

        # liquidctl — PSU und AIO getrennt gecached, damit iCUE nicht ständig
        # die USB-Devices verliert. PSU ist meist unkritisch (iCUE steuert da
        # nichts aktiv), AIO ist der Hauptkonfliktpunkt → separater Flag/Intervall.
        psu_enabled = bool(cfg.get("enable_liquidctl_psu", cfg.get("enable_liquidctl", True)))
        aio_enabled = bool(cfg.get("enable_liquidctl_aio", cfg.get("enable_liquidctl", False)))
        psu_interval = float(cfg.get("liquidctl_psu_interval_s",
                                     cfg.get("liquidctl_interval_s", LIQUIDCTL_PSU_INTERVAL_S_DEFAULT)))
        aio_interval = float(cfg.get("liquidctl_aio_interval_s",
                                     cfg.get("liquidctl_interval_s", LIQUIDCTL_AIO_INTERVAL_S_DEFAULT)))

        # PSU sampeln (eigener Cache)
        if psu_enabled and (now - self._lc_psu_last_t) >= psu_interval:
            try:
                res = _query_liquidctl(want_psu=True, want_aio=False, want_commander=False)
                self._lc_cache["psu"] = res.get("psu")
            except Exception:
                pass
            self._lc_psu_last_t = now
        elif not psu_enabled:
            self._lc_cache["psu"] = None

        # AIO sampeln (eigener Cache, deutlich seltener — minimiert iCUE-Störung)
        if aio_enabled and (now - self._lc_aio_last_t) >= aio_interval:
            try:
                res = _query_liquidctl(want_psu=False, want_aio=True, want_commander=True)
                self._lc_cache["aio"] = res.get("aio")
                self._lc_cache["commander"] = res.get("commander")
            except Exception:
                pass
            self._lc_aio_last_t = now
        elif not aio_enabled:
            self._lc_cache["aio"] = None
            self._lc_cache["commander"] = None

        lc = self._lc_cache

        # Akku
        battery = None
        try:
            bat = psutil.sensors_battery()
            if bat:
                battery = {
                    "percent": round(bat.percent, 1),
                    "plugged": bat.power_plugged,
                    "secsleft": bat.secsleft
                                if bat.secsleft != psutil.POWER_TIME_UNLIMITED else -1,
                }
        except Exception:
            pass

        # Top-Prozesse — CPU normalisiert (0–100 %)
        logical_cores = psutil.cpu_count(logical=True) or 1
        procs: List[Dict[str, Any]] = []
        try:
            iter_list = list(psutil.process_iter(
                ["pid", "name", "cpu_percent", "memory_info", "username"]))
        except Exception:
            iter_list = []
        iter_list.sort(key=lambda p: p.info.get("cpu_percent") or 0, reverse=True)
        for p in iter_list[:15]:
            try:
                raw_cpu = p.info["cpu_percent"] or 0
                mi = p.info["memory_info"]
                procs.append({
                    "pid": p.info["pid"],
                    "name": p.info["name"] or "?",
                    "user": p.info.get("username") or "",
                    "cpu": round(min(raw_cpu / logical_cores, 100.0), 1),
                    "ram_mb": round((mi.rss if mi else 0) / (1024 ** 2), 0),
                })
            except Exception:
                continue

        # Schwellwert-Klassifikation
        primary_disk = disks[0] if disks else (all_disks[0] if all_disks else None)
        primary_disk_pct = primary_disk["percent"] if primary_disk else 0
        alerts = {
            "cpu": _classify(cpu_total, thresholds.get("cpu", {})),
            "ram": _classify(mem.percent, thresholds.get("ram", {})),
            "disk": _classify(primary_disk_pct, thresholds.get("disk", {})),
            "cpu_temp": _classify(cpu_temp, thresholds.get("cpu_temp", {})),
            "gpu_temp": _classify(gpu.get("temp") if gpu else None,
                                  thresholds.get("gpu_temp", {})),
        }

        # Snapshot zusammenbauen
        primary_disk = disks[0] if disks else (all_disks[0] if all_disks else None)
        primary_disk_pct = primary_disk["percent"] if primary_disk else 0
        alerts = {
            "cpu": _classify(cpu_total, thresholds.get("cpu", {})),
            "ram": _classify(mem.percent, thresholds.get("ram", {})),
            "disk": _classify(primary_disk_pct, thresholds.get("disk", {})),
            "cpu_temp": _classify(cpu_temp, thresholds.get("cpu_temp", {})),
            "gpu_temp": _classify(gpu.get("temp") if gpu else None,
                                  thresholds.get("gpu_temp", {})),
        }

        snapshot = {
            "hostname": socket.gethostname(),
            "uptime": uptime_str(),
            "uptime_seconds": int(time.time() - psutil.boot_time()),
            "timestamp": int(now),
            "platform": {
                "system": platform.system(),
                "release": platform.release(),
                "kernel": platform.version(),
                "arch": platform.machine(),
                "python": platform.python_version(),
            },
            "cpu": {
                "percent": cpu_total,
                "per_core": [round(c, 1) for c in cpu_per_core],
                "info": self._cpu_model,
                "cores": psutil.cpu_count(logical=False),
                "threads": logical_cores,
                "freq_ghz": freq_ghz,
                "temp": cpu_temp,
            },
            "ram": {
                "percent": mem.percent,
                "used_gb": bytes_to_gb(mem.used),
                "total_gb": bytes_to_gb(mem.total),
                "free_gb": bytes_to_gb(mem.available),
                "swap_percent": swap_pct,
                "swap_used_gb": swap_used_gb,
                "swap_total_gb": swap_total_gb,
            },
            "disk": {
                "percent": primary_disk_pct,
                "used_gb": primary_disk["used_gb"] if primary_disk else 0,
                "total_gb": primary_disk["total_gb"] if primary_disk else 0,
                "free_gb": primary_disk["free_gb"] if primary_disk else 0,
                "label": primary_disk["label"] if primary_disk else "\u2014",
                "read_mbps": round(disk_read_mbps, 2),
                "write_mbps": round(disk_write_mbps, 2),
            },
            "disks": disks,
            "network": {
                "name": interfaces[0]["name"] if interfaces else "\u2014",
                "ip": interfaces[0]["ip"] if interfaces else "\u2014",
                "dl_kbps": interfaces[0]["dl_kbps"] if interfaces else 0.0,
                "ul_kbps": interfaces[0]["ul_kbps"] if interfaces else 0.0,
                "sent_gb": interfaces[0]["sent_gb"] if interfaces else 0.0,
                "recv_gb": interfaces[0]["recv_gb"] if interfaces else 0.0,
                "interfaces": interfaces,
                "total_dl_kbps": round(net_dl_kbps_total, 1),
                "total_ul_kbps": round(net_ul_kbps_total, 1),
            },
            "gpu": gpu,
            "battery": battery,
            "psu": lc["psu"],
            "aio": lc["aio"],
            "commander": lc["commander"],
            "processes": procs,
            "alerts": alerts,
            "sampled_at": now,
        }

        with self._lock:
            self._snapshot = snapshot
            self._history["cpu"].append((now, cpu_total))
            self._history["ram"].append((now, mem.percent))
            self._history["disk_read"].append((now, round(disk_read_mbps, 2)))
            self._history["disk_write"].append((now, round(disk_write_mbps, 2)))
            self._history["net_dl"].append((now, round(net_dl_kbps_total, 1)))
            self._history["net_ul"].append((now, round(net_ul_kbps_total, 1)))
            self._history["cpu_temp"].append((now, cpu_temp))
            self._history["gpu_load"].append((now, gpu.get("load") if gpu else None))
            self._history["gpu_temp"].append((now, gpu.get("temp") if gpu else None))

        self._prev_t = now

    def get_snapshot(self):
        with self._lock:
            return dict(self._snapshot) if self._snapshot else {}

    def get_history(self, metric, seconds):
        with self._lock:
            buf = self._history.get(metric)
            if buf is None:
                return []
            cutoff = time.time() - seconds
            return [[t, v] for (t, v) in buf if t >= cutoff]

    def get_all_history(self, seconds):
        with self._lock:
            cutoff = time.time() - seconds
            return {metric: [[t, v] for (t, v) in buf if t >= cutoff]
                    for metric, buf in self._history.items()}


# ââ FastAPI-App âââââââââââââ
app = FastAPI(title="System Monitor", version="2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_sampler = Sampler(history_seconds=_load_config().get("history_seconds", HISTORY_SECONDS_DEFAULT))


@app.on_event("startup")
def _on_startup():
    _sampler.start()
    try:
        _sampler._sample_once()
    except Exception:
        pass


@app.on_event("shutdown")
def _on_shutdown():
    _sampler.stop()


def _static(name, mime=None):
    path = os.path.join(_HERE, name)
    # Cache-Control: no-cache zwingt den Browser bei jedem Reload zu revalidieren
    # (verhindert das "alte Version nach Server-Neustart"-Problem).
    headers = {
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache",
        "Expires": "0",
    }
    if mime:
        return FileResponse(path, media_type=mime, headers=headers)
    return FileResponse(path, headers=headers)


@app.get("/")
def root():
    return _static("index.html")


@app.get("/style.css")
def css():
    return _static("style.css", "text/css")


@app.get("/app.js")
def js():
    return _static("app.js", "application/javascript")


@app.get("/settings")
def settings_page():
    return _static("settings.html")


@app.get("/settings.css")
def settings_css():
    return _static("settings.css", "text/css")


@app.get("/settings.js")
def settings_js():
    return _static("settings.js", "application/javascript")


@app.get("/favicon.ico")
def favicon():
    return JSONResponse(content="", status_code=204)


@app.get("/api/stats")
def get_stats():
    snap = _sampler.get_snapshot()
    if not snap:
        return {"hostname": socket.gethostname(), "uptime": uptime_str(), "warming_up": True}
    return snap


@app.get("/api/history")
def get_history(metric=None, seconds=120):
    seconds = max(1, min(int(seconds), _sampler.history_seconds))
    if metric:
        return {"metric": metric, "seconds": seconds, "data": _sampler.get_history(metric, seconds)}
    return {"seconds": seconds, "data": _sampler.get_all_history(seconds)}


@app.get("/api/system")
def get_system():
    try:
        boot = int(psutil.boot_time())
    except Exception:
        boot = 0
    return {
        "hostname": socket.gethostname(),
        "os": platform.system(),
        "os_release": platform.release(),
        "kernel": platform.version(),
        "arch": platform.machine(),
        "python": platform.python_version(),
        "cpu_model": _detect_cpu_model(),
        "cpu_cores": psutil.cpu_count(logical=False),
        "cpu_threads": psutil.cpu_count(logical=True),
        "ram_total_gb": bytes_to_gb(psutil.virtual_memory().total),
        "boot_time": boot,
    }


@app.get("/api/config")
def get_config():
    cfg = _load_config()
    return {k: v for k, v in cfg.items() if k != "auth_token"}


@app.post("/api/config")
async def post_config(request: Request):
    _check_auth(request)
    try:
        data = await request.json()
        existing = _load_config()
        data["auth_token"] = existing.get("auth_token", "")
        _save_config(data)
        new_hist = int(data.get("history_seconds", HISTORY_SECONDS_DEFAULT))
        if new_hist != _sampler.history_seconds:
            _sampler.history_seconds = new_hist
        return {"ok": True}
    except HTTPException:
        raise
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": str(e)})


@app.post("/api/auth")
async def check_auth(request: Request):
    try:
        body = await request.json()
        token = body.get("token", "")
        cfg = _load_config()
        cfg_token = cfg.get("auth_token", "")
        if not cfg_token:
            return JSONResponse(status_code=503, content={"error": "Kein Token konfiguriert."})
        if token == cfg_token:
            return {"ok": True}
        raise HTTPException(status_code=401, detail="Falsches Token")
    except HTTPException:
        raise
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": str(e)})


@app.post("/api/auth/change-token")
async def change_token(request: Request):
    _check_auth(request)
    try:
        body = await request.json()
        new_token = (body.get("token") or "").strip()
        if len(new_token) < 6:
            return JSONResponse(status_code=400, content={"error": "Token muss mindestens 6 Zeichen haben"})
        cfg = _load_config()
        cfg["auth_token"] = new_token
        _save_config(cfg)
        return {"ok": True}
    except HTTPException:
        raise
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": str(e)})


@app.get("/api/plugins")
async def list_plugins(request: Request):
    _check_auth(request)
    return _load_config().get("plugins", [])


@app.post("/api/plugins")
async def save_plugins(request: Request):
    _check_auth(request)
    try:
        plugins = await request.json()
        if not isinstance(plugins, list):
            return JSONResponse(status_code=400, content={"error": "Plugin-Liste erwartet"})
        cfg = _load_config()
        cfg["plugins"] = _normalise_plugins(plugins)
        _save_config(cfg)
        return {"ok": True}
    except HTTPException:
        raise
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": str(e)})


@app.get("/api/plugin/{plugin_id}")
async def run_plugin(plugin_id: str, request: Request):
    _check_auth(request)
    cfg = _load_config()
    plugin = next((p for p in cfg.get("plugins", []) if p.get("id") == plugin_id), None)
    if not plugin:
        raise HTTPException(status_code=404, detail="Plugin nicht gefunden")
    ptype = plugin.get("type", "shell")
    try:
        if ptype == "shell":
            cmd = plugin.get("command", "")
            result = subprocess.run(cmd, shell=True, capture_output=True, text=True,
                                    timeout=10, creationflags=NO_WINDOW)
            return {"id": plugin_id, "label": plugin.get("label"),
                    "output": result.stdout.strip(),
                    "error": result.stderr.strip() if result.returncode != 0 else None,
                    "exit_code": result.returncode}
        if ptype == "http":
            import urllib.request
            url = plugin.get("url", "")
            with urllib.request.urlopen(url, timeout=5) as r:
                data = r.read().decode("utf-8", errors="replace")
            return {"id": plugin_id, "label": plugin.get("label"), "output": data}
        return JSONResponse(status_code=400, content={"error": f"Unbekannter Plugin-Typ: {ptype}"})
    except subprocess.TimeoutExpired:
        return {"id": plugin_id, "label": plugin.get("label"),
                "output": None, "error": "Timeout (10s) ueberschritten"}
    except Exception as e:
        return {"id": plugin_id, "label": plugin.get("label"),
                "output": None, "error": str(e)}


@app.get("/api/disks")
def api_disks(request: Request):
    _check_auth(request)
    cfg = _load_config()
    disk_filter = cfg.get("disk_filter") or []
    result = []
    seen = set()
    try:
        for p in psutil.disk_partitions(all=False):
            mp = p.mountpoint
            if mp in seen:
                continue
            seen.add(mp)
            try:
                u = psutil.disk_usage(mp)
            except Exception:
                continue
            label = p.device.rstrip("\\") if IS_WINDOWS else mp
            result.append({
                "mountpoint": mp, "label": label, "device": p.device, "fstype": p.fstype,
                "total_gb": bytes_to_gb(u.total), "used_gb": bytes_to_gb(u.used),
                "free_gb": bytes_to_gb(u.free), "percent": u.percent,
                "enabled": (mp in disk_filter) if disk_filter else True,
            })
    except Exception:
        pass
    return result


@app.get("/api/interfaces")
def api_interfaces(request: Request):
    _check_auth(request)
    cfg = _load_config()
    net_filter = cfg.get("network_filter") or []
    try:
        net_addrs = psutil.net_if_addrs()
        net_stats = psutil.net_if_stats()
    except Exception:
        return []
    prio_order = ("Ethernet", "Wi-Fi", "eth", "en", "wlan") if IS_WINDOWS \
        else ("eth", "en", "wlan", "Wi-Fi", "Ethernet")
    candidates = []
    seen = set()
    for iface, addrs in net_addrs.items():
        try:
            st = net_stats.get(iface)
            if st and not st.isup:
                continue
            ip = next((a.address for a in addrs
                       if a.family == socket.AF_INET
                       and not a.address.startswith("127.")
                       and not a.address.startswith("169.254.")), None)
            if not ip:
                continue
            prio = next((i for i, p in enumerate(prio_order) if iface.startswith(p)), 99)
            if iface not in seen:
                seen.add(iface)
                candidates.append((prio, iface, ip))
        except Exception:
            continue
    candidates.sort()
    return [{"name": i, "ip": ip, "enabled": (i in net_filter) if net_filter else True}
            for _, i, ip in candidates]


@app.get("/api/psu-debug")
def psu_debug(request: Request):
    _check_auth(request)
    try:
        from liquidctl import find_liquidctl_devices
        out = []
        for dev in find_liquidctl_devices():
            with dev.connect():
                try:
                    dev.initialize()
                except Exception:
                    pass
                status = dev.get_status()
                out.append({
                    "description": getattr(dev, "description", str(dev)),
                    "status_raw": [list(s) for s in status],
                })
        return {"devices": out}
    except Exception as e:
        return {"error": str(e)}


def main():
    import uvicorn
    host = os.environ.get("SYSMON_HOST", "127.0.0.1")
    port = int(os.environ.get("SYSMON_PORT", "10800"))
    log_level = os.environ.get("SYSMON_LOG", "warning")
    print(f"[sysmon] starting on http://{host}:{port}  (log_level={log_level})")
    uvicorn.run(app, host=host, port=port, log_level=log_level)


if __name__ == "__main__":
    main()
