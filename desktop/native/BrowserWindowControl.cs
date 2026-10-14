// 只管理 CDP 返回的浏览器主进程窗口，不按标题或模糊路径匹配。
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Threading;

class BrowserWindowControl {
    delegate bool EnumProc(IntPtr window, IntPtr param);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr param);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr GetSystemMenu(IntPtr window, bool reset);
    [DllImport("user32.dll")] static extern uint EnableMenuItem(IntPtr menu, uint item, uint flags);
    [DllImport("user32.dll")] static extern uint GetMenuState(IntPtr menu, uint item, uint flags);
    [DllImport("user32.dll")] static extern bool DrawMenuBar(IntPtr window);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window, System.Text.StringBuilder text, int max);
    static bool visible = true;
    static volatile bool stopped;
    static int pid;
    static int visibleCount;
    static int closeDisabledCount;
    static HashSet<IntPtr> known = new HashSet<IntPtr>();
    static readonly object gate = new object();

    static int Apply(bool restore, bool force) {
        int count = 0;
        visibleCount = 0;
        closeDisabledCount = 0;
        EnumWindows((window, param) => {
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            if (owner != pid) return true;
            var name = new System.Text.StringBuilder(256);
            GetClassName(window, name, 256);
            if (name.ToString() != "Chrome_WidgetWin_1") return true;
            count++;
            // 禁用浏览器自己的窗口关闭入口，任务通过助手控制。
            var menu = GetSystemMenu(window, restore);
            if (!restore && menu != IntPtr.Zero) EnableMenuItem(menu, 0xF060, 0x0001);
            DrawMenuBar(window);
            bool first = known.Add(window);
            if (restore || (visible && (force || first))) {
                ShowWindow(window, 9);
                if (force) SetForegroundWindow(window);
            } else if (!visible && IsWindowVisible(window)) {
                ShowWindow(window, 0);
            }
            if (IsWindowVisible(window)) visibleCount++;
            if (!restore && menu != IntPtr.Zero && (GetMenuState(menu, 0xF060, 0) & 3) != 0) closeDisabledCount++;
            return true;
        }, IntPtr.Zero);
        return count;
    }

    static void Main(string[] args) {
        if (args.Length == 2 && args[0] == "--watch-owner") {
            int ownerPid;
            if (!int.TryParse(args[1], out ownerPid) || ownerPid <= 0) { Console.WriteLine("unknown"); return; }
            try {
                using (var ownerProcess = Process.GetProcessById(ownerPid)) {
                    if (!ownerProcess.HasExited) {
                        Console.WriteLine("alive");
                        ownerProcess.WaitForExit();
                    }
                    Console.WriteLine("gone");
                }
            } catch (ArgumentException) { Console.WriteLine("gone"); }
              catch { Console.WriteLine("unknown"); }
            return;
        }
        if (args.Length != 1 || !int.TryParse(args[0], out pid)) return;
        var owner = Process.GetProcessById(pid);
        // 固定进程对象，避免 PID 被重用后操作无关窗口。
        var reader = new Thread(() => {
            string command;
            while ((command = Console.ReadLine()) != null) {
                lock (gate) {
                    if (command == "restore") { Apply(true, true); stopped = true; return; }
                    if (command != "show" && command != "hide") continue;
                    visible = command == "show";
                    int count = Apply(false, true);
                    Console.WriteLine("{\"visible\":" + (visible ? "true" : "false") + ",\"count\":" + count + ",\"visibleCount\":" + visibleCount + ",\"closeDisabledCount\":" + closeDisabledCount + "}");
                }
            }
            lock (gate) { Apply(true, true); stopped = true; }
        });
        reader.IsBackground = true;
        reader.Start();
        while (!stopped && !owner.HasExited) {
            lock (gate) { Apply(false, false); }
            Thread.Sleep(250);
        }
        owner.Dispose();
    }
}
