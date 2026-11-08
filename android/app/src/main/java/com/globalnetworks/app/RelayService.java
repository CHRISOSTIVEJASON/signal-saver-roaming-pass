package com.globalnetworks.app;
import android.app.*;
import android.content.Intent;
import android.os.*;
public class RelayService extends Service {
 @Override public int onStartCommand(Intent intent,int flags,int startId){
  String channel="global-network-relay";
  if(Build.VERSION.SDK_INT>=26)((NotificationManager)getSystemService(NOTIFICATION_SERVICE)).createNotificationChannel(new NotificationChannel(channel,"Global Networks connection",NotificationManager.IMPORTANCE_LOW));
  Notification.Builder builder=Build.VERSION.SDK_INT>=26?new Notification.Builder(this,channel):new Notification.Builder(this);
  startForeground(1,builder.setSmallIcon(android.R.drawable.stat_sys_data_bluetooth).setContentTitle("Global Networks").setContentText("Connection service is running").setOngoing(true).build());
  return START_NOT_STICKY;
 }
 @Override public IBinder onBind(Intent intent){return null;}
}
