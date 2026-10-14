/**
 * 截取任务栏右侧区域（含系统托盘），并放大 3 倍便于辨认图标。
 */
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public class TrayShot2
{
    [DllImport("user32.dll")] static extern IntPtr FindWindow(string c, string w);
    [DllImport("user32.dll")] static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string c, string w);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll", CharSet = CharSet.Auto)] static extern int GetClassName(IntPtr h, System.Text.StringBuilder t, int n);
    [DllImport("user32.dll", CharSet = CharSet.Auto)] static extern int GetWindowText(IntPtr h, System.Text.StringBuilder t, int n);

    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

    public static void Main(string[] args)
    {
        string outPath = args.Length > 0 ? args[0] : "tray2.png";

        IntPtr tray = FindWindow("Shell_TrayWnd", null);
        IntPtr notify = FindWindowEx(tray, IntPtr.Zero, "TrayNotifyWnd", null);
        RECT nr;
        GetWindowRect(notify, out nr);
        Console.WriteLine("TrayNotifyWnd rect=(" + nr.Left + "," + nr.Top + "," + nr.Right + "," + nr.Bottom + ")");

        // 枚举 TrayNotifyWnd 的所有后代，找到持有图标按钮的那个
        Console.WriteLine("\n=== TrayNotifyWnd 子/孙窗口 ===");
        Dump(notify, 0, 3);

        // 截图：TrayNotifyWnd + 左侧 260px
        int left = Math.Max(0, nr.Left - 260);
        int right = nr.Right;
        int top = nr.Top;
        int bottom = nr.Bottom;
        int w = right - left, h = bottom - top;
        Console.WriteLine("\n截取区域: " + left + "," + top + " " + w + "x" + h);

        using (var bmp = new Bitmap(w, h))
        using (var g = Graphics.FromImage(bmp))
        {
            g.CopyFromScreen(left, top, 0, 0, new Size(w, h));
            // 放大 3 倍
            using (var big = new Bitmap(w * 3, h * 3))
            using (var g2 = Graphics.FromImage(big))
            {
                g2.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.NearestNeighbor;
                g2.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.Half;
                g2.DrawImage(bmp, 0, 0, w * 3, h * 3);
                big.Save(outPath, ImageFormat.Png);
            }
        }
        Console.WriteLine("已保存: " + outPath);
    }

    static void Dump(IntPtr parent, int depth, int maxDepth)
    {
        if (depth > maxDepth) return;
        IntPtr child = IntPtr.Zero;
        int i = 0;
        while ((child = FindWindowEx(parent, child, null, null)) != IntPtr.Zero && i < 40)
        {
            var cls = new System.Text.StringBuilder(256);
            var txt = new System.Text.StringBuilder(256);
            GetClassName(child, cls, 256);
            GetWindowText(child, txt, 256);
            RECT r; GetWindowRect(child, out r);
            Console.WriteLine(new string(' ', depth * 2) + "[" + i + "] class='" + cls + "' title='" + txt +
                "' rect=(" + r.Left + "," + r.Top + "," + r.Right + "," + r.Bottom + ")");
            Dump(child, depth + 1, maxDepth);
            i++;
        }
    }
}
