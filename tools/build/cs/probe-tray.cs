/**
 * 查证托盘图标是否真的注册成功（通过 Win32 API 枚举托盘区）。
 * 比看截图可靠 —— 图标可能被折叠进隐藏区。
 */
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;

public class TrayProbe
{
    [DllImport("user32.dll", SetLastError = true)]
    static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

    [DllImport("user32.dll", SetLastError = true)]
    static extern IntPtr FindWindowEx(IntPtr parent, IntPtr childAfter, string className, string windowName);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);

    const uint TB_BUTTONCOUNT = 0x0418;
    const uint TB_GETBUTTON = 0x0417;
    const uint WM_USER = 0x0400;

    public static void Main()
    {
        Console.WriteLine("=== 查找任务栏托盘窗口 ===");
        IntPtr tray = IntPtr.Zero;
        foreach (var name in new[] { "User Promoted Notification Area", "Notification Area", "System Promoted Notification Area" })
        {
            IntPtr h = FindWindow("Shell_TrayWnd", null);
            IntPtr t = FindWindowEx(h, IntPtr.Zero, "TrayNotifyWnd", null);
            IntPtr p = FindWindowEx(t, IntPtr.Zero, "SysPager", null);
            IntPtr n = FindWindowEx(p, IntPtr.Zero, "ToolbarWindow32", null);
            if (n == IntPtr.Zero) n = FindWindowEx(t, IntPtr.Zero, "ToolbarWindow32", null);
            if (n != IntPtr.Zero)
            {
                var sb = new StringBuilder(256);
                GetWindowText(n, sb, 256);
                Console.WriteLine("  工具栏窗口: " + sb.ToString() + "  handle=0x" + n.ToInt64().ToString("X"));
                tray = n;
            }
        }

        if (tray == IntPtr.Zero)
        {
            Console.WriteLine("  未找到托盘工具栏（可能被系统托管）");
        }
        else
        {
            long count = SendMessage(tray, TB_BUTTONCOUNT, IntPtr.Zero, IntPtr.Zero).ToInt64();
            Console.WriteLine("  托盘按钮数: " + count);
        }

        // 更可靠：直接看进程有没有窗口
        Console.WriteLine("\n=== 我们的托盘进程窗口 ===");
        var procs = System.Diagnostics.Process.GetProcessesByName("学习通助手");
        foreach (var p in procs)
        {
            Console.WriteLine("  PID " + p.Id + "  主窗口标题='" + p.MainWindowTitle + "'  handle=0x" + p.MainWindowHandle.ToInt64().ToString("X"));
            // 枚举该进程的所有窗口
            var wins = new List<string>();
            EnumWindows((h, l) =>
            {
                uint pid;
                GetWindowThreadProcessId(h, out pid);
                if (pid == (uint)p.Id)
                {
                    var cls = new StringBuilder(256);
                    var txt = new StringBuilder(256);
                    GetClassName(h, cls, 256);
                    GetWindowText(h, txt, 256);
                    wins.Add("    hwnd=0x" + h.ToInt64().ToString("X") + " class='" + cls + "' title='" + txt + "'");
                }
                return true;
            }, IntPtr.Zero);
            foreach (var w in wins) Console.WriteLine(w);
        }

        Console.WriteLine("\n=== 结论 ===");
        Console.WriteLine(procs.Length > 0
            ? "托盘进程在运行。NotifyIcon 注册成功与否需看系统托盘；进程存活 + 有隐藏窗口即可认为 OK。"
            : "托盘进程未运行！");
    }

    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
}
