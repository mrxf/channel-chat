import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'chat/chat_controller.dart';
import 'core/native.dart';
import 'core/prefs.dart';
import 'ui/chat_page.dart';
import 'ui/login_page.dart';
import 'ui/theme.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
  final prefs = await Prefs.load();
  if (prefs.protect) Native.setSecure(true);
  Native.initNotifications();
  runApp(AgentApp(prefs: prefs));
}

class AgentApp extends StatefulWidget {
  const AgentApp({super.key, required this.prefs});
  final Prefs prefs;
  @override
  State<AgentApp> createState() => _AgentAppState();
}

class _AgentAppState extends State<AgentApp> {
  late final chat = ChatController(widget.prefs);

  @override
  void dispose() {
    chat.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: widget.prefs,
      builder: (context, _) => MaterialApp(
        title: 'Agent',
        debugShowCheckedModeBanner: false,
        theme: buildTheme(Brightness.light),
        darkTheme: buildTheme(Brightness.dark),
        themeMode: widget.prefs.themeMode,
        home: ListenableBuilder(
          listenable: chat,
          builder: (context, _) => AnimatedSwitcher(
            duration: const Duration(milliseconds: 380),
            switchInCurve: Curves.easeOutCubic,
            switchOutCurve: Curves.easeInCubic,
            transitionBuilder: (child, a) => FadeTransition(
              opacity: a,
              child: SlideTransition(position: Tween(begin: const Offset(0, 0.03), end: Offset.zero).animate(a), child: child),
            ),
            child: chat.entered
                ? ChatPage(key: const ValueKey('chat'), chat: chat, prefs: widget.prefs)
                : LoginPage(key: const ValueKey('login'), chat: chat, prefs: widget.prefs),
          ),
        ),
      ),
    );
  }
}
