import { useEffect, useState } from 'react'
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native'
import { clearMessages, getMessages, markAllRead, type StoredMessage } from '../utils/messages'
import { onEvent } from '../utils/events'
import { formatJournalDate } from '../utils/format'
import { Button, colors, themedStyles } from '../components/ui'

const TYPE_COLOR: Record<StoredMessage['type'], string> = {
  success: colors.positive,
  error: colors.negative,
  warning: colors.amber,
}

export default function MessagesScreen() {
  const [messages, setMessages] = useState<StoredMessage[]>(getMessages)

  useEffect(() => {
    markAllRead()
    return onEvent('messages:updated', () => setMessages(getMessages()))
  }, [])

  return (
    <View style={styles.container}>
      <FlatList
        data={messages}
        keyExtractor={(m) => m.id}
        ListEmptyComponent={<Text style={styles.empty}>No messages yet.</Text>}
        renderItem={({ item }) => (
          <View style={styles.row}>
            <View style={[styles.dot, { backgroundColor: TYPE_COLOR[item.type] }]} />
            <View style={{ flex: 1 }}>
              <Text style={styles.message}>{item.message}</Text>
              <Text style={styles.ts}>{formatJournalDate(new Date(item.ts).toISOString())}</Text>
            </View>
          </View>
        )}
      />
      {messages.length > 0 ? (
        <Button title="Clear all" variant="secondary" onPress={() => { clearMessages(); setMessages([]) }} />
      ) : null}
    </View>
  )
}

const styles = themedStyles((c) => StyleSheet.create({
  container: { backgroundColor: c.bg, flex: 1, padding: 12 },
  dot: { borderRadius: 4, height: 8, marginTop: 6, width: 8 },
  empty: { color: c.muted, paddingVertical: 30, textAlign: 'center' },
  message: { color: c.text, fontSize: 13 },
  row: {
    borderBottomColor: c.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 8,
    paddingVertical: 10,
  },
  ts: { color: c.faint, fontSize: 10, marginTop: 2 },
}))
