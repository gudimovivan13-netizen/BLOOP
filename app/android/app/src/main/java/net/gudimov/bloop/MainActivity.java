package net.gudimov.bloop;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    // Разрешения нужны getUserMedia в WebView: съёмка рилсов (камера)
    // и голосовые сообщения (микрофон). Один запрос при первом запуске.
    @Override
    public void onStart() {
        super.onStart();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            String[] wanted = { Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO };
            for (String p : wanted) {
                if (ContextCompat.checkSelfPermission(this, p) != PackageManager.PERMISSION_GRANTED) {
                    requestPermissions(wanted, 4242);
                    return; // один диалог на оба разрешения
                }
            }
        }
    }
}
