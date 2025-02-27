const axios = require('axios');
const fs = require('fs');
const path = require('path');
const express = require('express');

require('dotenv').config();

const haproxyCfgPath = process.env.HAPROXYCFG_PATH;
const fetchDelay = process.env.FETCH_DELAY;
const serverPort = process.env.SERVER_PORT;
const prometheusUrl = process.env.PROMETHEUS_URL_API;
const nodesIP = process.env.NODES_IP.split(", ");

const cors = require('cors');
const app = express();

const { exec } = require('child_process');

app.use(cors());

app.use(express.static(path.join(__dirname)));

let data = {}; // This will store the latest ranked VMs

const fetchMetric = async (vmIP) => {
    try {
        const responses = await Promise.all(
            Object.entries({
                cpu: (vmIP) => `100-(avg(rate(node_cpu_seconds_total{mode="idle",instance="${vmIP}"}[1m]))by(instance)*100)`,
                
                memory: (vmIP) => `100*(1-(avg_over_time(node_memory_MemAvailable_bytes{instance="${vmIP}"}[1m])/avg_over_time(node_memory_MemTotal_bytes{instance="${vmIP}"}[1m])))`,
                
                disk: (vmIP) => `100*rate(node_disk_io_time_seconds_total{instance="${vmIP}",device="sda"}[1m])/(rate(node_disk_reads_completed_total{instance="${vmIP}",device="sda"}[1m])+rate(node_disk_writes_completed_total{instance="${vmIP}",device="sda"}[1m]))`,
                
                network: (vmIP) => `100*(rate(node_network_receive_bytes_total{instance="${vmIP}",device="eth0"}[1m])+rate(node_network_transmit_bytes_total{instance="${vmIP}",device="eth0"}[1m]))/12500000`
            })
            .map(([metric, query]) =>
                axios.get(prometheusUrl, { params: { query: query(vmIP) } })
                    .then(response => (
                        { [metric]: response.data.data.result[0]?.value[1] || null })
                    )
                    .catch(
                        () => (
                        { [metric]: null }
                    )
                )
            )
        );

        return {
            vm: vmIP.split(":")[0],
            metrics: Object.assign({}, ...responses)
        }

    } 
    catch {
        return { 
            vm: vmIP.split(":")[0], 
            metrics: { cpu: null, memory: null, disk: null, network: null } 
        };
    }
};

const updateConfigFile = (rankedVMLists, haproxyConfigPath) => {
    fs.readFile(haproxyConfigPath, 'utf8', (err, data) => {
        if (err) {
            console.error('Error reading haproxy.cfg:', err);
            return;
        }
    
        const lines = data.split('\n');
    
        const backendStartIndex = lines.findIndex(line => line.trim().startsWith('backend web_servers'));
        const backendEndIndex = lines.findIndex((line, index) => index > backendStartIndex && line.trim().startsWith('backend'));
    
        const backendSection = lines.slice(backendStartIndex, backendEndIndex === -1 ? lines.length : backendEndIndex);
    
        const newServerLines = rankedVMLists.map((ip, index) => {
            const weight = 5 - index;
            return `        server server${index + 1} ${ip}:80 check inter 2s rise 3 fall 2 weight ${weight}`;
        });
    
        const newBackendSection = backendSection.map(line => {
            if (line.trim().startsWith('server')) {
                return newServerLines.shift();
            }
            return line;
        });

        const newLines = [
            ...lines.slice(0, backendStartIndex),
            ...newBackendSection,
            ...lines.slice(backendEndIndex === -1 ? lines.length : backendEndIndex)
        ];
    
        const newConfig = newLines.join('\n');
    
        fs.writeFile(haproxyConfigPath, newConfig, 'utf8', (err) => {
            if (err) {
                console.error('Error writing haproxy.cfg:', err);
                return;
            }
            console.log('haproxy.cfg has been updated successfully.');

            if (process.env.RELOAD == 1) {
                const reloadCommand = 'haproxy -f /etc/haproxy/haproxy.cfg -sf $(cat /var/run/haproxy.pid)';
                exec(reloadCommand, (error, stdout, stderr) => {
                    if (error) {
                        console.error('Error reloading HAProxy:', error.message);
                        return;
                    }
                    if (stderr) {
                        console.error('HAProxy reload stderr:', stderr);
                        return;
                    }
                    console.log('HAProxy reloaded successfully:', stdout);
                });
            }
        });
    });
};

const fetchAndRankVMs = async () => {
    const vmResults = await Promise.all(
        nodesIP.map(fetchMetric)
    );

    const rankedVMs = vmResults
        .map(({ vm }) => ({
            vm,
            averageRank: Object.values(
                Object.fromEntries(
                    Object.keys(vmResults[0].metrics)
                        .map(metric => [metric, ((res,met) => Object.fromEntries(
                            [...res]
                            .sort((a, b) => (parseFloat(a.metrics[met]) || 0) - (parseFloat(b.metrics[met]) || 0))
                            .map(({ vm }, index) => [vm, index + 1])
                        ))(vmResults, metric)])))
                        .reduce((sum, rank) => sum + rank[vm], 0) / 4
        }))
        .sort((a, b) => a.averageRank - b.averageRank)
        .map(({ vm }) => vm);
    
    data["vmResults"] = vmResults;
    data["rankedVMs"] = rankedVMs;

    console.log(data);
    updateConfigFile(rankedVMs, haproxyCfgPath);
};

setInterval(fetchAndRankVMs, fetchDelay);

app.get('/ralba', (req, res) => {
    res.json({
        success: true,
        status: 200,
        data: {
            data
        }
    });
});



app.listen(serverPort, () => {
    console.log(`Run http://0.0.0.0:${serverPort}`);
    fetchAndRankVMs();
});