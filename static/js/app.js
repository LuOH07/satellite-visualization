// 等待页面完全加载
document.addEventListener('DOMContentLoaded', function() {
    console.log("开始初始化Cesium...");
    
    // 更新状态信息
    const statusInfo = document.getElementById('statusInfo');
    if (statusInfo) {
        statusInfo.textContent = "正在加载Cesium库...";
    }

    try {
        // 检查Cesium是否已加载
        if (typeof Cesium === 'undefined') {
            throw new Error('Cesium库未加载，请检查网络连接');
        }
        
        console.log("Cesium库已加载，版本:", Cesium.VERSION);

        // 设置Cesium令牌
        if (window.CESIUM_TOKEN) {
            Cesium.Ion.defaultAccessToken = window.CESIUM_TOKEN;
            console.log("Cesium令牌已设置");
        } else {
            console.warn("Cesium令牌未设置，使用默认令牌");
        }

        // 创建Cesium Viewer - 启用动画和时间线控件
        const viewer = new Cesium.Viewer('cesiumContainer', {
            terrainProvider: Cesium.createWorldTerrain(),
            animation: true,  // 启用动画控件
            timeline: true,   // 启用时间线控件
            homeButton: true,
            geocoder: true,
            baseLayerPicker: true,
            sceneModePicker: true,
            navigationHelpButton: true,
            fullscreenButton: true,
            vrButton: false,
            infoBox: false,
            selectionIndicator: false,
            shouldAnimate: false, // 初始不播放
            shadows: false, // 关闭阴影提高性能
            scene3DOnly: true, // 仅使用3D模式
            skyBox: false, // 关闭天空盒
            skyAtmosphere: false, // 关闭大气层
            contextOptions: {
                webgl: {
                    alpha: false,
                    antialias: true,
                    preserveDrawingBuffer: true,
                    failIfMajorPerformanceCaveat: false,
                    powerPreference: "high-performance"
                }
            }
        });

        console.log("Cesium Viewer创建成功");
        if (statusInfo) {
            statusInfo.textContent = "Cesium加载成功，正在初始化卫星数据...";
        }

        // 隐藏Cesium的logo和属性信息
        if (viewer.cesiumWidget && viewer.cesiumWidget.creditContainer) {
            viewer.cesiumWidget.creditContainer.style.display = "none";
        }
        
        // 设置Cesium控件位置
        if (viewer.homeButton && viewer.homeButton.viewModel) {
            viewer.homeButton.viewModel.command.beforeExecute.addEventListener(function(e) {
                e.cancel = true;
                resetView();
            });
        }

        // 存储实体
        const satelliteEntities = [];
        const orbitEntities = [];
        const projectionEntities = []; // 存储左右两个条带的实体

        // 卫星数据
        let satellitesData = [];
        let currentSatelliteIndex = -1;
        let isFocusMode = false;

        // 显示设置
        let showOrbits = true;
        let showProjections = true;
        let showLabels = true;

        // 时间控制状态
        let isPlaying = false;

        // 侧摆角度
        let currentSideAngle = 20;

        // 初始视角 - 从太空看地球
        const initialView = {
            destination: Cesium.Cartesian3.fromDegrees(0, 0, 25000000), // 2500万米高度
            orientation: {
                heading: Cesium.Math.toRadians(0),
                pitch: Cesium.Math.toRadians(-90),
                roll: 0
            }
        };

        // 颜色数组
        const colors = [
            Cesium.Color.RED,
            Cesium.Color.BLUE,
            Cesium.Color.GREEN,
            Cesium.Color.YELLOW,
            Cesium.Color.ORANGE,
            Cesium.Color.PURPLE,
            Cesium.Color.CYAN,
            Cesium.Color.PINK,
            Cesium.Color.LIME,
            Cesium.Color.GOLD
        ];

        // 设置初始视角
        viewer.camera.setView(initialView);

        // 绑定事件监听器
        function bindEventListeners() {
            // 绑定卫星项点击事件
            document.querySelectorAll('.satellite-item').forEach(item => {
                item.addEventListener('click', function () {
                    const index = parseInt(this.dataset.index);
                    selectSatellite(index);
                });
            });

            // 添加查看按钮的事件监听
            document.querySelectorAll('.view-satellite').forEach(button => {
                button.addEventListener('click', function (e) {
                    e.stopPropagation();
                    const index = parseInt(this.dataset.index);
                    focusOnSatellite(index);
                });
            });

            // 绑定按钮事件
            document.getElementById('resetView')?.addEventListener('click', resetView);
            document.getElementById('showAllSatellites')?.addEventListener('click', showAllSatellites);
            document.getElementById('jumpToTime')?.addEventListener('click', jumpToTime);
            document.getElementById('queryButton')?.addEventListener('click', queryCoverage);
            document.getElementById('toggleOrbits')?.addEventListener('click', toggleOrbits);
            document.getElementById('toggleProjections')?.addEventListener('click', toggleProjections);
            document.getElementById('toggleLabels')?.addEventListener('change', toggleLabels);
            document.getElementById('realTimeMode')?.addEventListener('change', toggleRealTimeMode);
            document.getElementById('updateSideAngle')?.addEventListener('click', updateSideAngle);
            document.getElementById('playPauseButton')?.addEventListener('click', togglePlayPause);
            document.getElementById('resetTimeButton')?.addEventListener('click', resetTime);
            document.getElementById('timeSpeedSelect')?.addEventListener('change', changeTimeSpeed);
        }

        // 延迟绑定事件监听器
        setTimeout(bindEventListeners, 500);

        // 选择卫星（在列表中高亮）
        function selectSatellite(index) {
            document.querySelectorAll('.satellite-item').forEach(item => {
                item.classList.remove('active');
            });
            const selectedItem = document.querySelector(`.satellite-item[data-index="${index}"]`);
            if (selectedItem) {
                selectedItem.classList.add('active');
            }
            currentSatelliteIndex = index;
        }

        // 聚焦到特定卫星（隐藏其他卫星）
        function focusOnSatellite(index) {
            if (!satellitesData[index]) {
                console.error(`卫星索引 ${index} 无效`);
                return;
            }
            
            console.log(`聚焦到卫星 ${index}: ${satellitesData[index].name}`);

            // 更新UI选择状态
            selectSatellite(index);

            // 设置焦点模式
            isFocusMode = true;

            // 隐藏所有卫星实体
            satelliteEntities.forEach((entity, i) => {
                if (entity) {
                    entity.show = (i === index);
                }
            });

            // 隐藏所有轨道
            orbitEntities.forEach((entity, i) => {
                if (entity) {
                    entity.show = (i === index) && showOrbits;
                }
            });

            // 隐藏所有地面投影（左右条带）
            projectionEntities.forEach((entity, i) => {
                if (entity) {
                    // 每个卫星有两个投影实体（左和右）
                    const satIndex = Math.floor(i / 2);
                    entity.show = (satIndex === index) && showProjections;
                }
            });

            // 飞向选中的卫星
            if (satelliteEntities[index]) {
                viewer.flyTo(satelliteEntities[index], {
                    duration: 2.0,
                    offset: new Cesium.HeadingPitchRange(0, -Math.PI / 4, 1000000)
                });
            }

            console.log(`已聚焦到卫星: ${satellitesData[index].name}`);
        }

        // 显示所有卫星
        function showAllSatellites() {
            console.log("显示所有卫星");

            // 清除选中状态
            document.querySelectorAll('.satellite-item').forEach(item => {
                item.classList.remove('active');
            });
            currentSatelliteIndex = -1;
            isFocusMode = false;

            // 显示所有实体
            satelliteEntities.forEach((entity, i) => {
                if (entity) {
                    entity.show = true;
                }
            });

            orbitEntities.forEach((entity, i) => {
                if (entity) {
                    entity.show = showOrbits;
                }
            });

            projectionEntities.forEach((entity, i) => {
                if (entity) {
                    entity.show = showProjections;
                }
            });

            console.log("已显示所有卫星");
        }

        // 重置视图
        function resetView() {
            showAllSatellites();
            viewer.camera.flyTo(initialView);
        }

        // 跳转到时间
        function jumpToTime() {
            const timeInput = document.getElementById('timeInput');
            const inputTime = new Date(timeInput.value);

            if (isNaN(inputTime.getTime())) {
                alert('请输入有效的时间格式');
                return;
            }

            const julianDate = Cesium.JulianDate.fromDate(inputTime);
            viewer.clock.currentTime = julianDate;
        }

        // 切换轨道显示
        function toggleOrbits() {
            showOrbits = !showOrbits;
            console.log(`切换轨道显示: ${showOrbits}`);

            if (isFocusMode && currentSatelliteIndex >= 0) {
                // 如果当前聚焦在单个卫星，只更新该卫星的轨道
                if (orbitEntities[currentSatelliteIndex]) {
                    orbitEntities[currentSatelliteIndex].show = showOrbits;
                }
            } else {
                // 否则更新所有轨道
                orbitEntities.forEach(entity => {
                    if (entity) entity.show = showOrbits;
                });
            }

            const toggleButton = document.getElementById('toggleOrbits');
            if (toggleButton) {
                toggleButton.textContent = showOrbits ? '隐藏轨道' : '显示轨道';
            }
        }

        // 切换地面投影
        function toggleProjections() {
            showProjections = !showProjections;
            console.log(`切换投影显示: ${showProjections}`);

            projectionEntities.forEach(entity => {
                if (entity) entity.show = showProjections;
            });

            const toggleButton = document.getElementById('toggleProjections');
            if (toggleButton) {
                toggleButton.textContent = showProjections ? '隐藏地面投影' : '显示地面投影';
            }
        }

        // 切换标签显示
        function toggleLabels() {
            showLabels = document.getElementById('toggleLabels').checked;
            console.log(`切换标签显示: ${showLabels}`);

            satelliteEntities.forEach(entity => {
                if (entity && entity.label) {
                    entity.label.show = showLabels;
                }
            });
        }

        // 切换实时模式
        function toggleRealTimeMode() {
            const realTimeMode = document.getElementById('realTimeMode').checked;
            if (realTimeMode) {
                // 实时模式：设置时钟为当前时间
                const currentTime = Cesium.JulianDate.fromDate(new Date());
                viewer.clock.currentTime = currentTime;
                viewer.clock.multiplier = 1;
                const timeSpeedSelect = document.getElementById('timeSpeedSelect');
                if (timeSpeedSelect) {
                    timeSpeedSelect.value = '1';
                }
            }
        }

        // 更新侧摆角度
        function updateSideAngle() {
            const sideAngleInput = document.getElementById('sideAngleInput');
            const newAngle = parseFloat(sideAngleInput.value);

            if (isNaN(newAngle) || newAngle < 0 || newAngle > 60) {
                alert('请输入0到60之间的有效角度');
                return;
            }

            currentSideAngle = newAngle;
            const currentSideAngleElement = document.getElementById('currentSideAngle');
            if (currentSideAngleElement) {
                currentSideAngleElement.textContent = newAngle + '°';
            }

            // 重新加载卫星数据
            loadSatelliteData();
        }

        // 时间控制功能
        function togglePlayPause() {
            isPlaying = !isPlaying;
            const playPauseButton = document.getElementById('playPauseButton');
            if (isPlaying) {
                viewer.clock.shouldAnimate = true;
                if (playPauseButton) {
                    playPauseButton.textContent = '❚❚ 暂停';
                }
            } else {
                viewer.clock.shouldAnimate = false;
                if (playPauseButton) {
                    playPauseButton.textContent = '▶ 播放';
                }
            }
        }

        function resetTime() {
            viewer.clock.currentTime = startTime.clone();
            if (isPlaying) {
                togglePlayPause();
            }
        }

        function changeTimeSpeed() {
            const speedSelect = document.getElementById('timeSpeedSelect');
            if (speedSelect) {
                const speed = parseFloat(speedSelect.value);
                viewer.clock.multiplier = speed;
                console.log(`时间速度设置为: ${speed}x`);
            }
        }

        // 查询覆盖 - 调用后端API进行精确计算
        function queryCoverage() {
            const latitude = parseFloat(document.getElementById('latitudeInput').value);
            const longitude = parseFloat(document.getElementById('longitudeInput').value);

            if (isNaN(latitude) || isNaN(longitude)) {
                alert('请输入有效的经纬度坐标');
                return;
            }
            
            // 验证经纬度范围
            if (!(-90 <= latitude <= 90)) {
                alert('纬度应在-90到90之间');
                return;
            }
            if (!(-180 <= longitude <= 180)) {
                alert('经度应在-180到180之间');
                return;
            }

            const resultsContainer = document.getElementById('queryResults');
            if (resultsContainer) {
                resultsContainer.innerHTML = '<div class="result-item">计算中，请稍候...</div>';
            }

            // 显示查询点在Cesium中
            showQueryPointOnMap(longitude, latitude);

            // 调用后端API进行精确的重访时间计算
            fetch(`/api/calculate_revisit_time?latitude=${latitude}&longitude=${longitude}&side_angle=${currentSideAngle}`)
                .then(response => {
                    if (!response.ok) {
                        throw new Error(`HTTP错误! 状态: ${response.status}`);
                    }
                    return response.json();
                })
                .then(data => {
                    displayQueryResultsFromAPI(data);
                })
                .catch(error => {
                    console.error('查询覆盖时间失败:', error);
                    const resultsContainer = document.getElementById('queryResults');
                    if (resultsContainer) {
                        resultsContainer.innerHTML = '<div class="result-item error">查询失败: ' + error.message + '</div>';
                    }
                });
        }

        // 在Cesium地图上显示查询点
        function showQueryPointOnMap(longitude, latitude) {
            // 移除之前的查询点
            const existingEntity = viewer.entities.getById('queryPoint');
            if (existingEntity) {
                viewer.entities.remove(existingEntity);
            }

            // 添加新的查询点
            viewer.entities.add({
                id: 'queryPoint',
                position: Cesium.Cartesian3.fromDegrees(longitude, latitude),
                point: {
                    pixelSize: 10,
                    color: Cesium.Color.RED,
                    outlineColor: Cesium.Color.WHITE,
                    outlineWidth: 2
                },
                label: {
                    text: `查询点: ${latitude.toFixed(4)}°, ${longitude.toFixed(4)}°`,
                    font: '14pt Microsoft YaHei',
                    fillColor: Cesium.Color.YELLOW,
                    outlineColor: Cesium.Color.BLACK,
                    outlineWidth: 2,
                    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                    pixelOffset: new Cesium.Cartesian2(0, 30)
                }
            });

            // 飞向查询点
            viewer.camera.flyTo({
                destination: Cesium.Cartesian3.fromDegrees(longitude, latitude, 1000000),
                duration: 1.0
            });
        }

        // 显示后端API返回的查询结果
        function displayQueryResultsFromAPI(data) {
            const resultsContainer = document.getElementById('queryResults');
            if (!resultsContainer) return;
            
            resultsContainer.innerHTML = '';
            
            if (data.error) {
                resultsContainer.innerHTML = '<div class="result-item error">错误: ' + data.error + '</div>';
                return;
            }
            
            if (data.total_coverage_events === 0) {
                resultsContainer.innerHTML = '<div class="result-item">该位置在24小时内无卫星覆盖</div>';
                return;
            }
            
            // 显示统计信息
            const statsItem = document.createElement('div');
            statsItem.className = 'result-item stats';
            statsItem.innerHTML = `
                <strong>覆盖统计</strong><br>
                总覆盖次数: ${data.total_coverage_events}<br>
                平均重访时间: ${data.average_revisit_hours ? data.average_revisit_hours.toFixed(2) : 'N/A'} 小时<br>
                最小重访时间: ${data.min_revisit_hours ? data.min_revisit_hours.toFixed(2) : 'N/A'} 小时<br>
                最大重访时间: ${data.max_revisit_hours ? data.max_revisit_hours.toFixed(2) : 'N/A'} 小时<br>
                覆盖百分比: ${data.coverage_percentage ? data.coverage_percentage.toFixed(2) : 'N/A'} %<br>
                查询位置: 纬度 ${data.query_point.latitude.toFixed(4)}°, 经度 ${data.query_point.longitude.toFixed(4)}°
            `;
            resultsContainer.appendChild(statsItem);
            
            // 显示每个覆盖事件
            data.coverage_times.forEach(event => {
                const resultItem = document.createElement('div');
                resultItem.className = 'result-item coverage-event';
                const time = new Date(event.time).toLocaleString();
                resultItem.innerHTML = `
                    <strong>${event.satellite}</strong><br>
                    时间: ${time}<br>
                    距离: ${event.distance_km.toFixed(2)} 公里<br>
                    卫星位置: 经度 ${event.satellite_position.longitude.toFixed(2)}°, 纬度 ${event.satellite_position.latitude.toFixed(2)}°, 高度 ${event.satellite_position.altitude.toFixed(0)} 米
                `;
                
                // 添加点击事件，点击时飞向卫星位置
                resultItem.addEventListener('click', function() {
                    viewer.camera.flyTo({
                        destination: Cesium.Cartesian3.fromDegrees(
                            event.satellite_position.longitude,
                            event.satellite_position.latitude,
                            event.satellite_position.altitude + 100000
                        ),
                        duration: 1.5
                    });
                });
                
                resultsContainer.appendChild(resultItem);
            });
            
            if (data.coverage_times.length < data.total_coverage_events) {
                const moreItem = document.createElement('div');
                moreItem.className = 'result-item';
                moreItem.innerHTML = `... 只显示前 ${data.coverage_times.length} 个事件，共 ${data.total_coverage_events} 个事件`;
                resultsContainer.appendChild(moreItem);
            }
        }

        // 时间设置
        let startTime;
        try {
            startTime = Cesium.JulianDate.fromDate(new Date(window.CURRENT_TIME_ISO || new Date()));
        } catch (e) {
            console.warn("无法解析当前时间，使用现在时间:", e);
            startTime = Cesium.JulianDate.fromDate(new Date());
        }
        
        const stopTime = Cesium.JulianDate.addSeconds(startTime, 24 * 3600, new Cesium.JulianDate());

        viewer.clock.startTime = startTime.clone();
        viewer.clock.stopTime = stopTime.clone();
        viewer.clock.currentTime = startTime.clone();
        viewer.clock.clockRange = Cesium.ClockRange.LOOP_STOP;
        viewer.clock.multiplier = 60;


        // 模型URL
        const model_url = window.MODEL_URL || "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/master/2.0/Duck/glTF/Duck.gltf";

        // 加载卫星数据函数
        function loadSatelliteData() {
            console.log('开始加载卫星数据...');
            const loadingMessage = document.getElementById('loadingMessage');
            if (loadingMessage) {
                loadingMessage.style.display = 'block';
            }
            
            if (statusInfo) {
                statusInfo.textContent = "正在从服务器加载卫星轨道数据...";
            }

            // 清除现有实体
            satelliteEntities.forEach(entity => {
                if (entity) viewer.entities.remove(entity);
            });
            orbitEntities.forEach(entity => {
                if (entity) viewer.entities.remove(entity);
            });
            projectionEntities.forEach(entity => {
                if (entity) viewer.entities.remove(entity);
            });

            satelliteEntities.length = 0;
            orbitEntities.length = 0;
            projectionEntities.length = 0;

            fetch(`/get_satellite_data?side_angle=${currentSideAngle}`)
                    .then(response => {
                        if (!response.ok) {
                            throw new Error(`HTTP错误! 状态: ${response.status}`);
                        }
                        return response.json();
                    })
                    .then(data => {
                        console.log('成功加载卫星数据:', data);
                        console.log('卫星数量:', data.length);

                        if (data.error) {
                            throw new Error(data.error);
                        }

                        satellitesData = data;

                        if (data.length === 0) {
                            if (loadingMessage) {
                                loadingMessage.innerHTML =
                                        '<div class="error-message">没有找到卫星数据</div>' +
                                        '<div>请检查卫星数据文件是否存在</div>';
                            }
                            return;
                        }

                        if (statusInfo) {
                            statusInfo.textContent =
                                    `成功加载 ${data.length} 颗卫星，正在创建轨道可视化...`;
                        }

                        // 创建卫星实体
                        satellitesData.forEach((sat, index) => {
                            try {
                                if (!sat.positions || sat.positions.length < 3) {
                                    console.warn(`卫星 ${sat.name} 的位置数据无效`);
                                    return;
                                }

                                const positions = Cesium.Cartesian3.fromDegreesArrayHeights(sat.positions);
                                const color = colors[index % colors.length];

                                // 创建轨道
                                const orbitEntity = viewer.entities.add({
                                    name: sat.name + '轨道',
                                    polyline: {
                                        positions: positions,
                                        width: 2,
                                        material: color.withAlpha(0.7),
                                        clampToGround: false
                                    },
                                    show: showOrbits
                                });
                                orbitEntities.push(orbitEntity);

                                // 创建左右两侧的地面投影条带
                                if (sat.leftSwath && sat.leftSwath.length > 0) {
                                    // 左侧条带
                                    const leftSwathEntity = viewer.entities.add({
                                        name: sat.name + '左侧投影',
                                        polyline: {
                                            positions: Cesium.Cartesian3.fromDegreesArrayHeights(sat.leftSwath),
                                            width: 2,
                                            material: Cesium.Color.WHITE.withAlpha(0.6),
                                            clampToGround: true
                                        },
                                        show: showProjections
                                    });
                                    projectionEntities.push(leftSwathEntity);
                                    console.log(`创建左侧条带: ${sat.name}, 点数: ${sat.leftSwath.length / 3}`);
                                }

                                if (sat.rightSwath && sat.rightSwath.length > 0) {
                                    // 右侧条带
                                    const rightSwathEntity = viewer.entities.add({
                                        name: sat.name + '右侧投影',
                                        polyline: {
                                            positions: Cesium.Cartesian3.fromDegreesArrayHeights(sat.rightSwath),
                                            width: 2,
                                            material: Cesium.Color.WHITE.withAlpha(0.6),
                                            clampToGround: true
                                        },
                                        show: showProjections
                                    });
                                    projectionEntities.push(rightSwathEntity);
                                    console.log(`创建右侧条带: ${sat.name}, 点数: ${sat.rightSwath.length / 3}`);
                                }

                                // 创建卫星位置属性
                                const satPosition = new Cesium.SampledPositionProperty();
                                const totalPoints = sat.positions.length / 3;
                                const timeStep = 24 * 3600 / totalPoints;

                                for (let i = 0; i < positions.length; i++) {
                                    const time = Cesium.JulianDate.addSeconds(
                                            startTime,
                                            i* timeStep,
                                            new Cesium.JulianDate()
                                    );
                                    satPosition.addSample(time, positions[i]);
                                }

                                // 创建卫星实体
                                const satEntity = viewer.entities.add({
                                    name: sat.name,
                                    position: satPosition,
                                    orientation: new Cesium.VelocityOrientationProperty(satPosition),
                                    model: {
                                        uri: model_url,
                                        scale: 100000.0,
                                        minimumPixelSize: 32,
                                        maximumScale: 200000,
                                        color: color,
                                        colorBlendMode: Cesium.ColorBlendMode.MIX,
                                        colorBlendAmount: 0.5
                                    },
                                    path: {
                                        resolution: 1,
                                        material: new Cesium.PolylineGlowMaterialProperty({
                                            glowPower: 0.2,
                                            color: color
                                        }),
                                        width: 3,
                                        show: false
                                    },
                                    label: {
                                        text: sat.name,
                                        font: '12pt Microsoft YaHei',
                                        pixelOffset: new Cesium.Cartesian2(0, -30),
                                        fillColor: color,
                                        outlineColor: Cesium.Color.BLACK,
                                        outlineWidth: 2,
                                        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                                        show: showLabels
                                    },
                                    availability: new Cesium.TimeIntervalCollection([
                                        new Cesium.TimeInterval({
                                            start: startTime,
                                            stop: stopTime
                                        })
                                    ])
                                });
                                satelliteEntities.push(satEntity);

                                console.log(`成功创建卫星实体: ${sat.name}`);

                            } catch (error) {
                                console.error(`创建卫星 ${sat.name} 实体时出错:`, error);
                                satelliteEntities.push(null);
                                orbitEntities.push(null);
                                projectionEntities.push(null);
                                projectionEntities.push(null);
                            }
                        });

                        // 完成初始化
                        setTimeout(() => {
                            if (loadingMessage) {
                                loadingMessage.style.display = 'none';
                            }
                            const timeInfo = document.getElementById('timeInfo');
                            if (timeInfo) {
                                timeInfo.textContent =
                                        `模拟时间范围: 24小时 (${data.length} 颗卫星, 侧摆角: ${currentSideAngle}°)`;
                            }
                            console.log('卫星可视化系统初始化完成');
                        }, 1000);

                    })
                    .catch(error => {
                        console.error('加载卫星数据失败:', error);
                        const loadingMessage = document.getElementById('loadingMessage');
                        if (loadingMessage) {
                            loadingMessage.innerHTML =
                                    '<div class="error-message">加载卫星数据失败</div>' +
                                    '<div>错误: ' + error.message + '</div>' +
                                    '<div style="margin-top: 10px;">请检查控制台获取详细信息</div>';
                        }
                    });
        }

        // 初始加载卫星数据
        loadSatelliteData();

    } catch (error) {
        console.error("初始化Cesium失败:", error);
        const loadingMessage = document.getElementById('loadingMessage');
        if (loadingMessage) {
            loadingMessage.innerHTML =
                    '<div class="error-message">初始化失败</div>' +
                    '<div>错误: ' + error.message + '</div>' +
                    '<div>请检查控制台获取详细信息</div>';
        }
        
        // 提供更多调试信息
        console.log("调试信息:");
        console.log("- Cesium是否定义:", typeof Cesium !== 'undefined');
        console.log("- CESIUM_TOKEN:", window.CESIUM_TOKEN ? "已设置" : "未设置");
        console.log("- MODEL_URL:", window.MODEL_URL);
        console.log("- CURRENT_TIME_ISO:", window.CURRENT_TIME_ISO);
    }
});