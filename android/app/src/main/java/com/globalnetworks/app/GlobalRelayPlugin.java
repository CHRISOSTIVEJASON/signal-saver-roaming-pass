package com.globalnetworks.app;

import android.Manifest;
import android.content.*;
import android.net.wifi.WifiManager;
import android.net.wifi.p2p.*;
import android.net.wifi.p2p.nsd.*;
import android.net.wifi.aware.*;
import android.os.*;
import android.provider.Settings;
import android.net.Uri;
import com.getcapacitor.*;
import com.getcapacitor.annotation.*;
import java.util.*;

@CapacitorPlugin(name="GlobalRelay", permissions={
 @Permission(alias="location",strings={Manifest.permission.ACCESS_FINE_LOCATION}),
 @Permission(alias="nearby",strings={"android.permission.NEARBY_WIFI_DEVICES"})
})
public class GlobalRelayPlugin extends Plugin {
 private WifiP2pManager manager; private WifiP2pManager.Channel channel;
 private WifiAwareSession awareSession; private PublishDiscoverySession publication;
 private BroadcastReceiver receiver; private boolean started=false, upstream=false;
 private JSObject relay; private final String networkName="DIRECT-GLOBAL-NETWORKS";
 @Override public void load(){
  manager=(WifiP2pManager)getContext().getSystemService(Context.WIFI_P2P_SERVICE);
  if(manager!=null)channel=manager.initialize(getContext(),Looper.getMainLooper(),null);
  receiver=new BroadcastReceiver(){@Override public void onReceive(Context c,Intent i){ if(granted())refreshGroup(); }};
  IntentFilter filter=new IntentFilter();filter.addAction(WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION);filter.addAction(WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION);
  if(Build.VERSION.SDK_INT>=33)getContext().registerReceiver(receiver,filter,Context.RECEIVER_NOT_EXPORTED);else getContext().registerReceiver(receiver,filter);
 }
 private boolean granted(){return getPermissionState("location")==PermissionState.GRANTED && (Build.VERSION.SDK_INT<33 || getPermissionState("nearby")==PermissionState.GRANTED);}
 @PluginMethod public void requestAccess(PluginCall call){
  if(granted()){accessResult(call);return;}
  requestPermissionForAliases(Build.VERSION.SDK_INT>=33?new String[]{"location","nearby"}:new String[]{"location"},call,"accessResult");
 }
 @PermissionCallback private void accessResult(PluginCall call){JSObject result=new JSObject();result.put("granted",granted());call.resolve(result);emit();}
 @PluginMethod public void openSettings(PluginCall call){getActivity().startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,Uri.parse("package:"+getContext().getPackageName())));call.resolve();}
 @PluginMethod public void getState(PluginCall call){if(granted())refreshGroup();call.resolve(state());}
 private JSObject state(){
  JSObject result=new JSObject();result.put("granted",granted());
  if(granted()){
   WifiManager wifi=(WifiManager)getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
   if(wifi!=null){android.net.wifi.WifiInfo info=wifi.getConnectionInfo();String ssid=info.getSSID(); if(ssid!=null&&!ssid.equals("<unknown ssid>")){result.put("ssid",ssid.replace("\"",""));result.put("bssid",info.getBSSID());}}
  }
  if(relay!=null)result.put("relay",relay);return result;
 }
 private void emit(){notifyListeners("stateChanged",state());}
 private WifiP2pManager.ActionListener action(){return new WifiP2pManager.ActionListener(){public void onSuccess(){refreshGroup();}public void onFailure(int reason){JSObject error=new JSObject();error.put("code",reason);notifyListeners("relayError",error);}};}
 @PluginMethod public void start(PluginCall call){
  upstream=call.getBoolean("upstreamInPool",false);
  if(!granted()){call.reject("Nearby Wi-Fi and location access are required");return;}
  if(manager==null||channel==null){call.reject("Wi-Fi Direct is not supported");return;}
  if(started){refreshGroup();call.resolve();return;}
  started=true;
  getContext().startForegroundService(new Intent(getContext(),RelayService.class));
  Map<String,String> record=new HashMap<>();record.put("identity",networkName);record.put("uplink",String.valueOf(upstream));
  manager.addLocalService(channel,WifiP2pDnsSdServiceInfo.newInstance("GLOBAL-NETWORKS","_globalnetworks._tcp",record),action());
  manager.setDnsSdResponseListeners(channel,(instance,type,device)->{
    if(!upstream && instance.equals("GLOBAL-NETWORKS")) {WifiP2pConfig config=new WifiP2pConfig();config.deviceAddress=device.deviceAddress;manager.connect(channel,config,action());}
  },(domain,txt,device)->{});
  manager.addServiceRequest(channel,WifiP2pDnsSdServiceRequest.newInstance(),action());
  manager.discoverServices(channel,action());
  if(upstream)manager.createGroup(channel,action());
  startAware();call.resolve();
 }
 private void startAware(){
  if(Build.VERSION.SDK_INT<26)return;
  WifiAwareManager aware=(WifiAwareManager)getContext().getSystemService(Context.WIFI_AWARE_SERVICE);
  if(aware==null||!aware.isAvailable())return;
  aware.attach(new AttachCallback(){@Override public void onAttached(WifiAwareSession session){
    awareSession=session;
    session.publish(new PublishConfig.Builder().setServiceName("global-networks").build(),new DiscoverySessionCallback(){@Override public void onPublishStarted(PublishDiscoverySession p){publication=p;}},new Handler(Looper.getMainLooper()));
  }},new Handler(Looper.getMainLooper()));
 }
 private void refreshGroup(){
  if(manager==null||channel==null||!granted())return;
  manager.requestGroupInfo(channel,group->{
    JSObject link=new JSObject();JSArray clients=new JSArray();
    if(group!=null){for(WifiP2pDevice client:group.getClientList())clients.put(client.deviceAddress);}
    String owner=group!=null&&group.getOwner()!=null?group.getOwner().deviceAddress:"";
    link.put("id",Settings.Secure.getString(getContext().getContentResolver(),Settings.Secure.ANDROID_ID));
    link.put("groupOwner",owner);link.put("clients",clients);link.put("networkName",group==null?networkName:group.getNetworkName());
    link.put("source","native");link.put("connected",group!=null);link.put("transportReady",false);link.put("upstreamInPool",upstream);
    link.put("updatedAt",System.currentTimeMillis());link.put("sentBytes",0);link.put("receivedBytes",0);
    // A local P2P group is not a verified internet forwarding transport. Never claim otherwise.
    relay=link;emit();
  });
 }
 @PluginMethod public void stop(PluginCall call){shutdown();call.resolve();}
 private void shutdown(){
  if(manager!=null&&channel!=null&&granted()){manager.stopPeerDiscovery(channel,null);manager.clearLocalServices(channel,null);manager.clearServiceRequests(channel,null);manager.removeGroup(channel,null);}
  if(publication!=null){publication.close();publication=null;}if(awareSession!=null){awareSession.close();awareSession=null;}
  getContext().stopService(new Intent(getContext(),RelayService.class));started=false;relay=null;
 }
 @Override protected void handleOnDestroy(){shutdown();if(receiver!=null)getContext().unregisterReceiver(receiver);if(channel!=null&&Build.VERSION.SDK_INT>=27)channel.close();}
}
