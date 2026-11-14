package com.ghostchat.mobile.data.crypto

import java.lang.StringBuilder
import kotlin.random.Random

object EmojiMapper {

    private val CHAR_TO_EMOJI: Map<Char, List<String>> = mapOf(
        // Uppercase letters (A-Z)
        'A' to listOf("😀", "😁", "😂", "🤣"),
        'B' to listOf("😃", "😄", "😅", "😆"),
        'C' to listOf("😉", "😊", "😋", "😜"),
        'D' to listOf("😍", "😘", "😗", "😙"),
        'E' to listOf("😚", "🙂", "🤗", "🤔"),
        'F' to listOf("😐", "😑", "😶", "🙄"),
        'G' to listOf("😏", "🧠", "🧛", "🧜"),
        'H' to listOf("🤐", "😌", "😔", "😪"),
        'I' to listOf("🤤", "😴", "😷", "🤒"),
        'J' to listOf("🤕", "🤢", "🤮", "🤧"),
        'K' to listOf("🥵", "🥶", "🥴", "😵"),
        'L' to listOf("🤯", "🤠", "🥳", "😎"),
        'M' to listOf("🤓", "🧐", "😕", "😟"),
        'N' to listOf("🙁", "😮", "😯", "😲"),
        'O' to listOf("😳", "🥺", "😦", "😧"),
        'P' to listOf("😨", "😰", "😥", "😢"),
        'Q' to listOf("😭", "😱", "😖", "😣"),
        'R' to listOf("😞", "😓", "😩", "😫"),
        'S' to listOf("😤", "😡", "😠", "🤬"),
        'T' to listOf("😈", "👿", "💀", "☠️"),
        'U' to listOf("💩", "🤡", "👹", "👺"),
        'V' to listOf("👻", "🧟", "👽", "🤖"),
        'W' to listOf("🎃", "😺", "😸", "😹"),
        'X' to listOf("😻", "😼", "😽", "🙀"),
        'Y' to listOf("😿", "😾", "🙈", "🙉"),
        'Z' to listOf("🙊", "💋", "💌", "💘"),

        // Lowercase letters (a-z)
        'a' to listOf("🐶", "🐱", "🐭", "🐹"),
        'b' to listOf("🐰", "🦊", "🐻", "🐼"),
        'c' to listOf("🐨", "🐯", "🦁", "🐮"),
        'd' to listOf("🐷", "🐸", "🐒", "🐔"),
        'e' to listOf("🐧", "🐦", "🐤", "🐣"),
        'f' to listOf("🐥", "🐺", "🐗", "🐴"),
        'g' to listOf("🦄", "🐝", "🐛", "🦋"),
        'h' to listOf("🐌", "🐞", "🐜", "🕷️"),
        'i' to listOf("🦂", "🐢", "🐍", "🦎"),
        'j' to listOf("🐙", "🦑", "🐬", "🐳"),
        'k' to listOf("🐋", "🦈", "🐊", "🐅"),
        'l' to listOf("🐆", "🦓", "🦍", "🦧"),
        'm' to listOf("🐘", "🦛", "🦏", "🐪"),
        'n' to listOf("🐫", "🦒", "🦘", "🐃"),
        'o' to listOf("🐂", "🐄", "🐎", "🐖"),
        'p' to listOf("🐏", "🐑", "🐐", "🦌"),
        'q' to listOf("🐕", "🐩", "🐈", "🐓"),
        'r' to listOf("🦃", "🕊️", "🐇", "🦝"),
        's' to listOf("🦨", "🦡", "🦦", "🦥"),
        't' to listOf("🐁", "🐀", "🐿️", "🦔"),
        'u' to listOf("🐉", "🐲", "🌵", "🎄"),
        'v' to listOf("🌲", "🌳", "🌴", "🌿"),
        'w' to listOf("🍀", "🍁", "🍂", "🍃"),
        'x' to listOf("🍇", "🍈", "🍉", "🍊"),
        'y' to listOf("🍋", "🍌", "🍍", "🥭"),
        'z' to listOf("🍎", "🍏", "🍐", "🍑"),

        // Digits (0-9)
        '0' to listOf("0️⃣", "0⃣", "⓿"),
        '1' to listOf("1️⃣", "1⃣", "❶"),
        '2' to listOf("2️⃣", "2⃣", "❷"),
        '3' to listOf("3️⃣", "3⃣", "❸"),
        '4' to listOf("4️⃣", "4⃣", "❹"),
        '5' to listOf("5️⃣", "5⃣", "❺"),
        '6' to listOf("6️⃣", "6⃣", "❻"),
        '7' to listOf("7️⃣", "7⃣", "❼"),
        '8' to listOf("8️⃣", "8⃣", "❽"),
        '9' to listOf("9️⃣", "9⃣", "❾"),

        // Base64 special characters
        '+' to listOf("➕", "✚", "🆙", "🔼"),
        '/' to listOf("➗", "〰️", "🪢", "➿"),
        '=' to listOf("🟰", "≣", "🇪", "⚖️")
    )

    private val EMOJI_TO_CHAR: Map<String, Char> by lazy {
        val map = mutableMapOf<String, Char>()
        for ((char, emojis) in CHAR_TO_EMOJI) {
            for (emoji in emojis) {
                if (!map.containsKey(emoji)) {
                    map[emoji] = char
                }
            }
        }
        map
    }

    fun textToEmojis(text: String, deterministic: Boolean = false): String {
        if (text.isEmpty()) return ""
        val sb = StringBuilder()
        for (ch in text) {
            val emojis = CHAR_TO_EMOJI[ch]
            if (emojis != null && emojis.isNotEmpty()) {
                if (deterministic) {
                    sb.append(emojis[0])
                } else {
                    val randomEmoji = emojis[Random.nextInt(emojis.size)]
                    sb.append(randomEmoji)
                }
            } else {
                sb.append(ch)
            }
        }
        return sb.toString()
    }

    fun emojisToText(emojiString: String): String {
        if (emojiString.isEmpty()) return ""
        val sb = StringBuilder()
        var i = 0
        while (i < emojiString.length) {
            var matched = false
            // Try matching 4 code points, 3 code points, 2 code points, 1 code point
            val maxLen = minOf(8, emojiString.length - i)
            for (len in maxLen downTo 1) {
                val candidate = emojiString.substring(i, i + len)
                if (EMOJI_TO_CHAR.containsKey(candidate)) {
                    sb.append(EMOJI_TO_CHAR[candidate])
                    i += len
                    matched = true
                    break
                }
            }
            if (!matched) {
                sb.append(emojiString[i])
                i++
            }
        }
        return sb.toString()
    }
}
