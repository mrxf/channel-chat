// 视觉主题：沿用桌面端的暖色调（浅色）与中性深色，强调色为品牌陶土色
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

const brand = Color(0xFFD97757);

const memberColors = [
  Color(0xFFD97757),
  Color(0xFF5B8DEF),
  Color(0xFF3FA37A),
  Color(0xFFB06CD8),
  Color(0xFFC9962A),
  Color(0xFFE05D8C),
  Color(0xFF2FA7B8),
  Color(0xFF7D8A5A),
];

@immutable
class Palette extends ThemeExtension<Palette> {
  const Palette({
    required this.bg,
    required this.side,
    required this.panel,
    required this.text,
    required this.muted,
    required this.line,
    required this.bubble,
    required this.hover,
    required this.codeBg,
    required this.preBg,
    required this.preText,
    required this.good,
    required this.bad,
    required this.proseSerif,
  });

  final Color bg, side, panel, text, muted, line, bubble, hover, codeBg, preBg, preText, good, bad;
  final bool proseSerif;

  static const light = Palette(
    bg: Color(0xFFFAF9F5),
    side: Color(0xFFF3F1EA),
    panel: Color(0xFFFFFFFF),
    text: Color(0xFF2B2A27),
    muted: Color(0xFF8A877E),
    line: Color(0xFFE6E2D8),
    bubble: Color(0xFFEFECE3),
    hover: Color(0xFFEBE8DE),
    codeBg: Color(0xFFF1EEE6),
    preBg: Color(0xFF2B2A27),
    preText: Color(0xFFF0EEE6),
    good: Color(0xFF2F9E55),
    bad: Color(0xFFD4483F),
    proseSerif: true,
  );

  static const dark = Palette(
    bg: Color(0xFF1C1B1A),
    side: Color(0xFF161615),
    panel: Color(0xFF262624),
    text: Color(0xFFE8E7E3),
    muted: Color(0xFF8E8C86),
    line: Color(0xFF34332F),
    bubble: Color(0xFF302F2C),
    hover: Color(0xFF2A2927),
    codeBg: Color(0xFF2C2B28),
    preBg: Color(0xFF111110),
    preText: Color(0xFFE3E2DE),
    good: Color(0xFF3FB950),
    bad: Color(0xFFE5534B),
    proseSerif: false,
  );

  @override
  Palette copyWith() => this;

  @override
  Palette lerp(Palette? other, double t) {
    if (other == null) return this;
    Color l(Color a, Color b) => Color.lerp(a, b, t)!;
    return Palette(
      bg: l(bg, other.bg),
      side: l(side, other.side),
      panel: l(panel, other.panel),
      text: l(text, other.text),
      muted: l(muted, other.muted),
      line: l(line, other.line),
      bubble: l(bubble, other.bubble),
      hover: l(hover, other.hover),
      codeBg: l(codeBg, other.codeBg),
      preBg: l(preBg, other.preBg),
      preText: l(preText, other.preText),
      good: l(good, other.good),
      bad: l(bad, other.bad),
      proseSerif: t < 0.5 ? proseSerif : other.proseSerif,
    );
  }
}

extension PaletteX on BuildContext {
  Palette get pal => Theme.of(this).extension<Palette>()!;
}

const serifFamily = 'serif';
const monoFamily = 'monospace';

ThemeData buildTheme(Brightness b) {
  final p = b == Brightness.light ? Palette.light : Palette.dark;
  final scheme = ColorScheme.fromSeed(
    seedColor: brand,
    brightness: b,
    primary: brand,
    onPrimary: Colors.white,
    surface: p.bg,
    onSurface: p.text,
    surfaceContainerLowest: p.panel,
    surfaceContainerLow: p.side,
    surfaceContainer: p.side,
    surfaceContainerHigh: p.panel,
    surfaceContainerHighest: p.bubble,
    outline: p.line,
    outlineVariant: p.line,
    onSurfaceVariant: p.muted,
    error: p.bad,
  );
  final base = ThemeData(useMaterial3: true, brightness: b, colorScheme: scheme);
  final text = base.textTheme.apply(bodyColor: p.text, displayColor: p.text);
  return base.copyWith(
    scaffoldBackgroundColor: p.bg,
    extensions: [p],
    textTheme: text,
    splashFactory: InkSparkle.splashFactory,
    appBarTheme: AppBarTheme(
      backgroundColor: p.bg,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      scrolledUnderElevation: 0,
      foregroundColor: p.text,
      centerTitle: true,
      systemOverlayStyle: (b == Brightness.light ? SystemUiOverlayStyle.dark : SystemUiOverlayStyle.light).copyWith(
        statusBarColor: Colors.transparent,
        systemNavigationBarColor: p.bg,
        systemNavigationBarDividerColor: Colors.transparent,
      ),
    ),
    drawerTheme: DrawerThemeData(backgroundColor: p.side, surfaceTintColor: Colors.transparent, width: 304),
    dividerTheme: DividerThemeData(color: p.line, thickness: 1, space: 1),
    bottomSheetTheme: BottomSheetThemeData(
      backgroundColor: p.panel,
      surfaceTintColor: Colors.transparent,
      modalBackgroundColor: p.panel,
      showDragHandle: true,
      dragHandleColor: p.line,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
    ),
    snackBarTheme: SnackBarThemeData(
      behavior: SnackBarBehavior.floating,
      backgroundColor: b == Brightness.light ? const Color(0xFF2B2A27) : const Color(0xFFE8E7E3),
      contentTextStyle: TextStyle(color: b == Brightness.light ? Colors.white : const Color(0xFF1C1B1A), fontSize: 14),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      insetPadding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: p.panel,
      hintStyle: TextStyle(color: p.muted.withValues(alpha: 0.8)),
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      border: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: BorderSide(color: p.line)),
      enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: BorderSide(color: p.line)),
      focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: BorderSide(color: p.muted, width: 1.2)),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: b == Brightness.light ? p.text : p.text,
        foregroundColor: b == Brightness.light ? Colors.white : p.bg,
        disabledBackgroundColor: p.line,
        minimumSize: const Size.fromHeight(52),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
        textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600, letterSpacing: 0.2),
      ),
    ),
    switchTheme: SwitchThemeData(
      thumbColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? Colors.white : p.muted),
      trackColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? brand : p.bubble),
      trackOutlineColor: WidgetStateProperty.all(Colors.transparent),
    ),
    popupMenuTheme: PopupMenuThemeData(
      color: p.panel,
      surfaceTintColor: Colors.transparent,
      elevation: 8,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14), side: BorderSide(color: p.line)),
    ),
    dialogTheme: DialogThemeData(backgroundColor: p.panel, surfaceTintColor: Colors.transparent),
    pageTransitionsTheme: const PageTransitionsTheme(builders: {
      TargetPlatform.android: PredictiveBackPageTransitionsBuilder(),
    }),
  );
}
